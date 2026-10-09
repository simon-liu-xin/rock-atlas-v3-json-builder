import { createPublicKey } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { validateSchemaDocument } from '../../src/data/schema-registry.ts';
import { canonicalJsonV1 } from '../../src/data/contracts/catalog-v3.ts';
import { sha256Hex, verifyCatalogPointerSignature } from '../../src/data/publication/catalog-signature.ts';
import { FULL_FRONTEND_NAMESPACES } from '../../src/data/publication/catalog-full-projection-v3.ts';

// Runs entirely locally. No auth, API request or upload is performed by this verifier.
export async function verifyCloudflarePublication({ dist, trustedKeys, fileLimit = 20_000, catalogOnly = false }) {
  if (!Number.isInteger(fileLimit) || fileLimit < 1 || fileLimit > 100_000) throw new Error('Invalid Pages file limit');
  dist = resolve(dist);
  const files = await inventory(dist);
  if (files.length > fileLimit) throw new Error(`Pages file limit exceeded: ${files.length} > ${fileLimit}. Use fewer shards or a separate data host.`);
  let totalBytes = 0, largestFile = { path: '', bytes: 0 };
  for (const file of files) {
    if (file.bytes > 25 * 1024 * 1024) throw new Error(`Pages 25 MiB file limit exceeded: ${file.path}`);
    if (/(^|\/)(?:\.env[^/]*|node_modules|database|\.git)(\/|$)|\.(?:pem|key|sql|dump|backup|jsonl)$/i.test(file.path)) {
      throw new Error(`Non-public file in dist: ${file.path}`);
    }
    if (file.path.startsWith('data/rock-catalog-v2/')) throw new Error('V2 runtime data remains in dist; archive it outside public before deploying V3');
    totalBytes += file.bytes;
    if (file.bytes > largestFile.bytes) largestFile = file;
  }
  if (!catalogOnly) {
  for (const name of ['index.html', '404.html', '_headers', '_redirects']) await regularFile(join(dist, name));
  const headers = await readFile(join(dist, '_headers'), 'utf8');
  const redirects = await readFile(join(dist, '_redirects'), 'utf8');
  if (!headers.includes('/data/rock-catalog-v3/current.json\n  Cache-Control: no-cache, must-revalidate') ||
      !headers.includes('Content-Type: application/gzip') || /^\s*Content-Encoding:/im.test(headers)) {
    throw new Error('V3 requires a fresh pointer and raw gzip object responses; check _headers');
  }
  if (/^\/\*\s/m.test(redirects) || !redirects.includes('/experiment/* / 200') || !redirects.includes('/evidence/* / 200')) {
    throw new Error('Use explicit SPA rewrites; missing JSON and JS must return 404');
  }
  }
  const pointer = JSON.parse(await readFile(join(dist, 'data/rock-catalog-v3/current.json'), 'utf8'));
  if (!catalogOnly) {
  const client = JSON.parse(await readFile(join(dist, 'catalog-client.json'), 'utf8'));
  if (client.channel !== 'rock-catalog-v3' || client.schema_version !== '3.0' ||
      client.trusted_keys_sha256 !== sha256Hex(Buffer.from(canonicalJsonV1(trustedKeys)))) {
    throw new Error('The built frontend signing-key set is stale; rebuild before publishing');
  }
  }
  await validateSchemaDocument('catalog-pointer-v3', pointer);
  const keys = Object.fromEntries(Object.entries(trustedKeys).map(([id, value]) => {
    if (value.jwk?.d) throw new Error('A private signing key must never be bundled');
    const now = Date.now();
    if ((value.not_before && now < Date.parse(value.not_before)) || (value.not_after && now > Date.parse(value.not_after))) {
      if (id === pointer.key_id) throw new Error('The active signing key is outside its validity window');
    }
    return [id, createPublicKey({ key: value.jwk, format: 'jwk' })];
  }));
  const signature = verifyCatalogPointerSignature(pointer, keys);
  if (!signature.verified) throw new Error(signature.reason);
  const verified = new Map();
  const recordCounts = {};
  const readObject = async (entry) => {
    const previous = verified.get(entry.url);
    if (previous) {
      if (previous !== canonicalJsonV1(entry)) throw new Error('Conflicting object metadata');
    }
    const path = localPath(dist, entry.url);
    await regularFile(path);
    const bytes = await readFile(path);
    if (sha256Hex(bytes) !== entry.object_sha256 || (entry.object_bytes !== undefined && bytes.length !== entry.object_bytes)) {
      throw new Error(`Object hash or size mismatch: ${entry.url}`);
    }
    const content = entry.compression === 'gzip' || entry.url.endsWith('.json.gz')
      ? gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 }) : bytes;
    if (sha256Hex(content) !== entry.content_sha256 || (entry.content_bytes !== undefined && content.length !== entry.content_bytes)) {
      throw new Error(`Content hash or size mismatch: ${entry.url}`);
    }
    const parsed = JSON.parse(content.toString('utf8'));
    verified.set(entry.url, canonicalJsonV1(entry));
    return parsed;
  };
  const root = await readObject({ url: pointer.root_manifest_url, compression: 'identity',
    object_sha256: pointer.root_manifest_object_sha256, content_sha256: pointer.root_manifest_content_sha256 });
  await validateSchemaDocument('catalog-root-manifest-v3', root);
  if (root.generation_id !== pointer.generation_id || root.gate_a.status === 'fail') throw new Error('Generation mismatch or failed data gate');
  const namespaces = new Set(root.namespaces.map((value) => value.namespace));
  if (FULL_FRONTEND_NAMESPACES.some((value) => !namespaces.has(value))) throw new Error('The homepage requires all twelve V3 namespaces');
  const overview = await readObject(root.overview);
  if (overview.styles?.length !== root.counts.canonical.styles ||
      new Set(overview.styles.map((row) => row.entity_id)).size !== overview.styles.length ||
      overview.styles.some((row) => !overview.layout?.[row.entity_id])) throw new Error('Overview style counts or layout are incomplete');
  const visited = new Set();
  async function visit(entry, namespace) {
    if (visited.has(entry.url)) throw new Error('Repeated namespace manifest or manifest cycle');
    visited.add(entry.url);
    const manifest = await readObject(entry);
    await validateSchemaDocument('catalog-namespace-manifest-v3', manifest);
    if (manifest.generation_id !== root.generation_id || manifest.namespace !== namespace) throw new Error('Namespace generation mismatch');
    for (const bucket of manifest.buckets) {
      const leaf = await readObject(bucket);
      if (leaf.namespace !== namespace || !leaf.records || Object.keys(leaf.records).length !== bucket.record_count) throw new Error('Leaf namespace or record count mismatch');
      recordCounts[namespace] = (recordCounts[namespace] ?? 0) + bucket.record_count;
    }
    for (const shard of manifest.shards ?? []) await visit(shard.manifest, namespace);
  }
  for (const namespace of root.namespaces) await visit(namespace.manifest, namespace.namespace);
  for (const [namespace, count] of [['style-summary', 'styles'], ['artist-summary', 'artists'], ['release-group-summary', 'release_groups'], ['relation', 'relations'], ['evidence', 'evidence']]) {
    if ((recordCounts[namespace] ?? 0) !== root.counts.canonical[count]) throw new Error(`Canonical ${count} count mismatch`);
  }
  if (root.gate_a.report) await readObject(root.gate_a.report);
  return { channel: pointer.channel, generation_id: pointer.generation_id,
    pointer_sha256: sha256Hex(Buffer.from(canonicalJsonV1(pointer))), gate_a: root.gate_a.status,
    counts: root.counts.canonical, verified_objects: verified.size, files: files.length,
    total_bytes: totalBytes, largest_file: largestFile, file_limit: fileLimit };
}

function localPath(dist, url) {
  if (typeof url !== 'string' || !/^\/data\/rock-catalog-v3\/[a-zA-Z0-9._/-]+$/.test(url) || url.split('/').includes('..')) throw new Error('Unsafe or external catalog URL');
  const path = resolve(dist, `.${url}`);
  if (!path.startsWith(`${dist}${sep}`)) throw new Error('Catalog URL escapes dist');
  return path;
}
async function regularFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular publication file: ${path}`);
  return stat;
}
async function inventory(root, prefix = '') {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Publication directories must be real directories');
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await inventory(path, name));
    else result.push({ path: name, bytes: (await regularFile(path)).size });
  }
  return result;
}
