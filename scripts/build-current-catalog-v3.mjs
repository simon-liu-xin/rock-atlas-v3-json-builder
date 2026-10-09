import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdir, lstat, open, readFile, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { projectCurrentCatalogV3 } from '../src/data/publication/current-catalog-projection-v3.ts';
import { buildCatalogExportV3, verifyCatalogExportBundle } from '../src/data/publication/catalog-exporter-v3.ts';
import { FilesystemPublicationStore } from '../src/data/publication/filesystem-publication-store.ts';
import { validatePublishedCatalog } from '../src/experiment/readiness/published-catalog.ts';
import { canonicalJsonV1 } from '../src/data/contracts/catalog-v3.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await main().catch((error) => { process.stderr.write(`Error: ${error.message}\n`); process.exitCode = 1; });
async function main() {
  const args = process.argv.slice(2);
  if (args.some((value, i) => i % 2 === 0 && !['--signing-key', '--key-id', '--output-dir', '--backend-root'].includes(value)) || args.length % 2) {
    throw new Error('Usage: node scripts/build-current-catalog-v3.mjs [--signing-key ABSOLUTE_PEM] [--key-id ID] [--output-dir ABSOLUTE_DIRECTORY] [--backend-root ABSOLUTE_BACKEND_REPOSITORY]');
  }
  const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]));
  const keyPath = options['--signing-key'] ?? process.env.ROCK_ATLAS_SIGNING_KEY ?? join(homedir(), '.local/share/rock-atlas/current-catalog-v3.pem');
  const keyId = options['--key-id'] ?? 'rock-atlas-current-v3';
  const output = options['--output-dir'] ?? join(root, 'public/data/rock-catalog-v3');
  if (!isAbsolute(keyPath) || !isAbsolute(output)) throw new Error('Signing key and output directory must be absolute');
  const backendRoot = options['--backend-root'] ?? process.env.ROCK_ATLAS_BACKEND_ROOT ?? root;
  if (!isAbsolute(backendRoot)) throw new Error('Backend root must be absolute');
  const inputDir = join(backendRoot, 'data/published/rock-catalog-v2');
  const manifest = JSON.parse(await readFile(join(inputDir, 'manifest.json'), 'utf8'));
  const canonicalBytes = await readFile(join(inputDir, 'canonical-catalog.json'));
  const frontendBytes = await readFile(join(inputDir, 'frontend-catalog.json'));
  for (const [label, bytes] of [['canonical', canonicalBytes], ['frontend', frontendBytes]]) {
    if (bytes.length !== manifest.outputs[label].bytes || sha(bytes) !== manifest.outputs[label].sha256) throw new Error(`Input ${label} differs from its audited SQL publication`);
  }
  if (manifest.outputs.frontend.origin !== 'postgresql-generation') throw new Error('Migration requires the audited SQL-exported corpus');
  const canonical = JSON.parse(canonicalBytes.toString('utf8'));
  const frontend = validatePublishedCatalog(JSON.parse(frontendBytes.toString('utf8')));
  const seed = JSON.parse(await readFile(join(backendRoot, 'data/fixtures/experiment-v1/sample.json'), 'utf8'));
  const projection = projectCurrentCatalogV3(canonical, frontend, seed);
  const privateKey = await loadSigningKey(keyPath);
  const projectionHash = sha(Buffer.from(canonicalJsonV1(projection))).slice(0, 12);
  const generationId = `mw:catalog-generation:${canonical.generation_id.toLowerCase()}-v3-${projectionHash}`;
  const bundle = buildCatalogExportV3({ generation_id: generationId, generated_at: canonical.generated_at,
    published_at: canonical.generated_at, sources: canonical.source_snapshots.map((row) => {
      if (!row.redistributable) throw new Error('Non-redistributable source in current migration');
      return { source: row.source_name, snapshot_id: row.snapshot_id, license_partition: row.license_partition };
    }), counts: projection.counts, overview: projection.overview, namespaces: projection.namespaces,
    license_decision_ids: [...new Set([
      ...canonical.source_snapshots.map((row) => `mw:license-decision:${row.license_partition}`),
      ...canonical.style_relations_v2.map((row) => `mw:license-decision:${row.license_partition}`),
    ])].sort(), gate_a: { status: 'not-run', report_url: null }, leaf_hard_limit_bytes: 512 * 1024,
    key_id: keyId, private_key: privateKey,
  });
  verifyCatalogExportBundle(bundle);
  const store = new FilesystemPublicationStore(output);
  for (const artifact of bundle.artifacts) {
    await store.putImmutable(artifact.storage_key, artifact.bytes);
    if (!Buffer.from(await store.read(artifact.storage_key)).equals(Buffer.from(artifact.bytes))) throw new Error('Publication readback mismatch');
  }
  const trustPath = join(root, 'src/data/catalog/trusted-catalog-keys.json');
  const trust = JSON.parse(await readFile(trustPath, 'utf8'));
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  if (trust[keyId] && JSON.stringify(trust[keyId].jwk) !== JSON.stringify(jwk)) throw new Error('Signing key ID is already bound to another key');
  trust[keyId] = { jwk };
  await atomicWrite(trustPath, Buffer.from(`${JSON.stringify(trust, null, 2)}\n`));
  await store.withPointerLock('current.json', () => store.replacePointerAtomically('current.json', bundle.pointer_bytes));
  await atomicWrite(join(output, 'migration-report.json'), Buffer.from(`${JSON.stringify({
    scope: 'current-audited-corpus', full_catalog_ready: false, source_generation: canonical.generation_id,
    generation_id: generationId, source_canonical_sha256: sha(canonicalBytes), source_frontend_sha256: sha(frontendBytes),
    counts: projection.counts, ...bundle.report,
  }, null, 2)}\n`));
  process.stdout.write(`${JSON.stringify({ generation_id: generationId, scope: 'current-audited-corpus', output_dir: output, counts: projection.counts, ...bundle.report }, null, 2)}\n`);
}
async function loadSigningKey(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const info = await lstat(path).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) {
    const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(key); await file.sync(); } finally { await file.close(); }
  } else if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077))) {
    throw new Error('Signing key must be an owner-only regular file');
  }
  const key = createPrivateKey(await readFile(path));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Signing key must be Ed25519');
  return key;
}
async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  const file = await open(temp, 'wx', 0o644);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  await rename(temp, path);
}
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
