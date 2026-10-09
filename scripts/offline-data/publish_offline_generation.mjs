import { createPrivateKey, createPublicKey } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from 'node:url';

import { publishCatalogJsonlV3 } from "../../src/data/publication/catalog-jsonl-exporter-v3.ts";
import { FilesystemPublicationStore } from '../../src/data/publication/filesystem-publication-store.ts';
import { canonicalJsonV1 } from '../../src/data/contracts/catalog-v3.ts';

export const FULL_CATALOG_POINTER_CONFIRMATION = "I_CONFIRM_ATOMIC_POINTER_SWITCH";

await main().catch((error) => {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const privateKeyPath = await validatePrivateKey(options.signingKey);
  const privateKey = createPrivateKey(await readFile(privateKeyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Catalog signing key must be Ed25519");
  const trustRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/data/catalog');
  const trustPath = resolve(trustRoot, 'trusted-catalog-keys.json');
  const publicKey = { jwk: createPublicKey(privateKey).export({ format: 'jwk' }) };
  const trustStore = new FilesystemPublicationStore(trustRoot);
  await trustStore.withPointerLock('trusted-catalog-keys.json', async () => {
    const trust = JSON.parse(await readFile(trustPath, 'utf8'));
    if (trust[options.keyId] && canonicalJsonV1(trust[options.keyId].jwk) !== canonicalJsonV1(publicKey.jwk)) {
      throw new Error('Signing key ID is already bound to a different key');
    }
    // A failed data publication may leave an unused public key, never an unverifiable active pointer.
    await trustStore.replacePointerAtomically('trusted-catalog-keys.json', Buffer.from(`${JSON.stringify({ ...trust, [options.keyId]: trust[options.keyId] ?? publicKey }, null, 2)}\n`));
  });
  const report = await publishCatalogJsonlV3({
    projection_manifest_path: resolve(options.projectionManifest),
    static_root: resolve(options.staticRoot),
    key_id: options.keyId,
    private_key: privateKey,
    published_at: new Date(options.publishedAt ?? Date.now()).toISOString(),
    gate_a_report_path: options.gateAReport ? resolve(options.gateAReport) : undefined,
    leaf_hard_limit_bytes: options.leafHardLimit,
    publish_current: options.publishAuthorization === FULL_CATALOG_POINTER_CONFIRMATION,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function parseArguments(argv) {
  const options = {
    projectionManifest: null,
    staticRoot: null,
    signingKey: null,
    keyId: null,
    publishedAt: null,
    gateAReport: null,
    leafHardLimit: 512 * 1024,
    publishAuthorization: null,
  };
  const definitions = {
    "--projection-manifest": ["projectionManifest", "string"],
    "--static-root": ["staticRoot", "string"],
    "--signing-key": ["signingKey", "string"],
    "--key-id": ["keyId", "string"],
    "--published-at": ["publishedAt", "string"],
    "--gate-a-report": ["gateAReport", "string"],
    "--leaf-hard-limit-bytes": ["leafHardLimit", "integer"],
    "--publish-authorization": ["publishAuthorization", "string"],
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const definition = definitions[argument];
    if (!definition) throw new Error(`Unknown argument: ${argument}`);
    if (seen.has(argument)) throw new Error(`${argument} may only be provided once`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    options[definition[0]] = definition[1] === "integer" ? positiveInteger(value, argument) : value;
    seen.add(argument);
    index += 1;
  }
  for (const key of ["projectionManifest", "staticRoot", "signingKey", "keyId"]) {
    if (!options[key]) throw new Error(`Missing required option for ${key}`);
  }
  if (![options.projectionManifest, options.staticRoot, options.signingKey].every(isAbsolute) ||
      (options.gateAReport !== null && !isAbsolute(options.gateAReport))) {
    throw new Error("Projection manifest, static root, signing key and Gate A report paths must be absolute");
  }
  if (options.publishAuthorization !== null &&
      options.publishAuthorization !== FULL_CATALOG_POINTER_CONFIRMATION) {
    throw new Error(`--publish-authorization must equal ${FULL_CATALOG_POINTER_CONFIRMATION}`);
  }
  if (options.publishedAt !== null && !Number.isFinite(Date.parse(options.publishedAt))) {
    throw new Error("--published-at must be an ISO timestamp");
  }
  return options;
}

async function validatePrivateKey(path) {
  if (!isAbsolute(path)) throw new Error("--signing-key must be absolute");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Signing key must be a regular non-symlink file");
  if ((info.mode & 0o077) !== 0) throw new Error("Signing key permissions must not allow group or world access");
  return realpath(path);
}

function positiveInteger(value, label) {
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 256) {
    throw new Error(`${label} must be an integer of at least 256`);
  }
  return Number(value);
}
