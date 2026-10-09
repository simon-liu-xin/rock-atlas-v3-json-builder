import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { canonicalJsonV1 } from '../src/data/contracts/catalog-v3.ts';
import { FilesystemPublicationStore } from '../src/data/publication/filesystem-publication-store.ts';
import { verifyCloudflarePublication } from './lib/cloudflare-static-publication.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await main().catch((error) => { process.stderr.write(`同步失败：${error.message}\n`); process.exitCode = 1; });
async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--frontend-root', '--static-root', '--trusted-keys'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: npm run data:frontend:sync -- --frontend-root ABSOLUTE_FRONTEND [--static-root ABSOLUTE_V3_DIRECTORY] [--trusted-keys ABSOLUTE_PUBLIC_TRUST_FILE]');
    options[args[i]] = args[i + 1];
  }
  const frontend = options['--frontend-root'] ?? resolve(root, '../rock-atlas-v3-frontend');
  const staticRoot = options['--static-root'] ?? join(root, 'public/data/rock-catalog-v3');
  if (!isAbsolute(frontend) || !isAbsolute(staticRoot) || frontend === root) throw new Error('Use distinct absolute repository paths');
  const packageInfo = JSON.parse(await readFile(join(frontend, 'package.json'), 'utf8'));
  if (packageInfo.name !== 'rock-atlas-v3-frontend') throw new Error('Target is not the Rock Atlas V3 frontend');
  if (resolve(staticRoot) !== resolve(dirname(staticRoot), 'rock-catalog-v3') ||
      !resolve(staticRoot).endsWith('/data/rock-catalog-v3') && !resolve(staticRoot).endsWith('\\data\\rock-catalog-v3')) {
    throw new Error('Static root must use the data/rock-catalog-v3 directory structure');
  }
  const trustPath = options['--trusted-keys'] ?? join(root, 'src/data/catalog/trusted-catalog-keys.json');
  if (!isAbsolute(trustPath)) throw new Error('Trust file must be absolute');
  const trusted = JSON.parse(await readFile(trustPath, 'utf8'));
  const report = await verifyCloudflarePublication({ dist: resolve(staticRoot, '../..'), trustedKeys: trusted, catalogOnly: true, fileLimit: 100_000 });
  const pointer = JSON.parse(await readFile(join(staticRoot, 'current.json'), 'utf8'));
  if (createHash('sha256').update(canonicalJsonV1(pointer)).digest('hex') !== report.pointer_sha256) {
    throw new Error('Source pointer changed during verification; retry without updating the frontend');
  }
  const activeKey = trusted[pointer.key_id];
  if (!activeKey) throw new Error('Verified source key is unavailable');
  const store = new FilesystemPublicationStore(join(frontend, 'public/data/rock-catalog-v3'));
  for await (const path of files(staticRoot)) {
    if (path === 'current.json' || path === 'migration-report.json') continue;
    await store.putImmutable(path, await readFile(join(staticRoot, path)));
  }
  const keyStore = new FilesystemPublicationStore(join(frontend, 'src/data/catalog'));
  await store.withPointerLock('current.json', async () => {
    const currentKeys = JSON.parse(await readFile(join(frontend, 'src/data/catalog/trusted-catalog-keys.json'), 'utf8'));
    if (currentKeys[pointer.key_id] && canonicalJsonV1(currentKeys[pointer.key_id]) !== canonicalJsonV1(activeKey)) throw new Error('Frontend key ID already refers to a different key');
    await keyStore.replacePointerAtomically('trusted-catalog-keys.json', Buffer.from(`${JSON.stringify({ ...currentKeys, [pointer.key_id]: activeKey }, null, 2)}\n`));
    await store.replacePointerAtomically('current.json', Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`));
  });
  process.stdout.write(`${JSON.stringify({ frontend, generation_id: pointer.generation_id, counts: report.counts, verified_objects: report.verified_objects, next: 'Run npm run deploy:cloudflare:check in the frontend' }, null, 2)}\n`);
}
async function* files(directory, prefix = '') {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Static directories must not be symlinks');
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* files(join(directory, entry.name), path);
    else if (entry.isFile()) yield path;
    else throw new Error('Static publication cannot contain symlinks');
  }
}
