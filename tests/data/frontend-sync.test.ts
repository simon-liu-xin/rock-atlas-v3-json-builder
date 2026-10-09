import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';
import { buildCatalogExportV3 } from '../../src/data/publication/catalog-exporter-v3.ts';
import { FULL_FRONTEND_NAMESPACES } from '../../src/data/publication/catalog-full-projection-v3.ts';
const execute = promisify(execFile);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rock-atlas-handoff-'));
  const frontend = join(root, 'frontend'), staticRoot = join(root, 'public/data/rock-catalog-v3');
  const keys = generateKeyPairSync('ed25519');
  const namespaces: Record<string, Record<string, unknown>> = Object.fromEntries(FULL_FRONTEND_NAMESPACES.map((name) => [name, {}]));
  const style = { entity_id: 'mw:style:test', name: 'Test', era: null, region: null, artist_count: 0, source_url: null };
  namespaces['style-summary']![style.entity_id] = style;
  const bundle = buildCatalogExportV3({ generation_id: 'mw:catalog-generation:handoff-test', generated_at: '2026-10-09T00:00:00Z', published_at: '2026-10-09T00:00:00Z',
    counts: { canonical: { styles: 1, artists: 0, release_groups: 0, relations: 0, evidence: 0 }, projections: {} },
    overview: { styles: [style], relations: [], layout: { [style.entity_id]: { x: 0, y: 0, z: 0 } } }, namespaces,
    sources: [{ source: 'fixture', snapshot_id: 'fixture', license_partition: 'CC0-1.0' }], license_decision_ids: ['fixture'],
    gate_a: { status: 'not-run', report_url: null }, key_id: 'test-handoff', private_key: keys.privateKey, leaf_hard_limit_bytes: 512 * 1024 });
  for (const artifact of bundle.artifacts) { const path = join(staticRoot, artifact.storage_key); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, artifact.bytes); }
  await writeFile(join(staticRoot, 'current.json'), bundle.pointer_bytes);
  await mkdir(join(frontend, 'src/data/catalog'), { recursive: true });
  await writeFile(join(frontend, 'package.json'), JSON.stringify({ name: 'rock-atlas-v3-frontend' }));
  await writeFile(join(frontend, 'src/data/catalog/trusted-catalog-keys.json'), '{}');
  const publicKeyPath = join(root, 'trusted.json');
  await writeFile(publicKeyPath, JSON.stringify({ 'test-handoff': { jwk: keys.publicKey.export({ format: 'jwk' }) } }));
  return { root, frontend, staticRoot, bundle, publicKeyPath };
}

describe('verified frontend handoff', () => {
  test('copies all immutable objects and key before publishing the pointer, and is repeatable', async () => {
    const f = await fixture();
    try {
      for (let attempt = 0; attempt < 2; attempt++) await execute(process.execPath, [resolve('scripts/sync-frontend.mjs'), '--frontend-root', f.frontend,
        '--static-root', f.staticRoot, '--trusted-keys', f.publicKeyPath]);
      const pointer = JSON.parse(await readFile(join(f.frontend, 'public/data/rock-catalog-v3/current.json'), 'utf8'));
      expect(pointer.generation_id).toBe(f.bundle.pointer.generation_id);
      const trust = JSON.parse(await readFile(join(f.frontend, 'src/data/catalog/trusted-catalog-keys.json'), 'utf8'));
      expect(trust['test-handoff']).toBeTruthy();
      for (const artifact of f.bundle.artifacts) expect(await readFile(join(f.frontend, 'public/data/rock-catalog-v3', artifact.storage_key))).toEqual(Buffer.from(artifact.bytes));
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  test('tampering stops before touching frontend pointer or trust', async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.staticRoot, f.bundle.artifacts.find((row) => row.kind === 'leaf')!.storage_key), 'tampered');
      await expect(execute(process.execPath, [resolve('scripts/sync-frontend.mjs'), '--frontend-root', f.frontend,
        '--static-root', f.staticRoot, '--trusted-keys', f.publicKeyPath])).rejects.toThrow(/hash|size/);
      await expect(readFile(join(f.frontend, 'public/data/rock-catalog-v3/current.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(f.frontend, 'src/data/catalog/trusted-catalog-keys.json'), 'utf8')).toBe('{}');
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
