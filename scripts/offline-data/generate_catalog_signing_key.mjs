import { generateKeyPairSync } from "node:crypto";
import { open, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

await main().catch((error) => {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const privatePath = await validateNewFile(options.privateKey, "private key");
  const publicPath = await validateNewFile(options.publicJwk, "public JWK");
  const keys = generateKeyPairSync("ed25519");
  const privateBytes = Buffer.from(keys.privateKey.export({ type: "pkcs8", format: "pem" }));
  const publicBytes = Buffer.from(`${JSON.stringify({
    key_id: options.keyId,
    algorithm: "Ed25519",
    jwk: keys.publicKey.export({ format: "jwk" }),
  }, null, 2)}\n`);
  const privateTemporary = `${privatePath}.tmp-${process.pid}`;
  const publicTemporary = `${publicPath}.tmp-${process.pid}`;
  let privatePublished = false;
  let publicPublished = false;
  try {
    await writeSecure(privateTemporary, privateBytes, 0o600);
    await writeSecure(publicTemporary, publicBytes, 0o644);
    await rename(publicTemporary, publicPath);
    publicPublished = true;
    await rename(privateTemporary, privatePath);
    privatePublished = true;
  } finally {
    if (!privatePublished) await rm(privateTemporary, { force: true });
    if (!publicPublished) await rm(publicTemporary, { force: true });
  }
  process.stdout.write(`${JSON.stringify({
    key_id: options.keyId,
    private_key_path: privatePath,
    public_jwk_path: publicPath,
  }, null, 2)}\n`);
}

function parseArguments(argv) {
  const options = { privateKey: null, publicJwk: null, keyId: null };
  const definitions = {
    "--private-key": "privateKey",
    "--public-jwk": "publicJwk",
    "--key-id": "keyId",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const key = definitions[argument];
    if (!key) throw new Error(`Unknown argument: ${argument}`);
    if (options[key] !== null) throw new Error(`${argument} may only be provided once`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    options[key] = value;
    index += 1;
  }
  if (!options.privateKey || !options.publicJwk || !options.keyId) {
    throw new Error("--private-key, --public-jwk and --key-id are required");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(options.keyId)) throw new Error("Invalid key id");
  return options;
}

async function validateNewFile(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  const resolved = resolve(path);
  await realpath(dirname(resolved));
  await stat(resolved).then(() => { throw new Error(`${label} path already exists`); }, (error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  return resolved;
}

async function writeSecure(path, bytes, mode) {
  const handle = await open(path, "wx", mode);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
