import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { canonicalJsonV1 } from "../../src/data/contracts/catalog-v3.ts";
import {
  publishCatalogJsonlV3,
  type PreparedCatalogProjectionV3,
} from "../../src/data/publication/catalog-jsonl-exporter-v3.ts";
import { FULL_FRONTEND_NAMESPACES } from "../../src/data/publication/catalog-full-projection-v3.ts";
import { verifyCatalogPointerSignature } from "../../src/data/publication/catalog-signature.ts";
import { StaticShardedCatalogRepository } from "../../src/data/catalog/static-sharded-catalog-repository.ts";

describe("catalog JSONL exporter V3", () => {
  test("streams sorted namespaces into bounded immutable buckets and atomically publishes current", async () => {
    const root = await mkdtemp(join(tmpdir(), "catalog-jsonl-v3-"));
    const fixture = await writeFixture(root, 180);
    const keys = generateKeyPairSync("ed25519");

    const first = await publishCatalogJsonlV3({
      projection_manifest_path: fixture.manifestPath,
      static_root: fixture.staticRoot,
      key_id: "catalog-production-2026",
      private_key: keys.privateKey,
      published_at: "2026-09-01T00:01:00Z",
      gate_a_report_path: fixture.gateAReportPath,
      leaf_hard_limit_bytes: 520,
      namespace_manifest_hard_limit_bytes: 8192,
      publish_current: true,
    });
    const second = await publishCatalogJsonlV3({
      projection_manifest_path: fixture.manifestPath,
      static_root: fixture.staticRoot,
      key_id: "catalog-production-2026",
      private_key: keys.privateKey,
      published_at: "2026-09-01T00:01:00Z",
      gate_a_report_path: fixture.gateAReportPath,
      leaf_hard_limit_bytes: 520,
      namespace_manifest_hard_limit_bytes: 8192,
      publish_current: true,
    });

    expect(first).toEqual(second);
    expect(first.current_pointer_updated).toBe(true);
    expect(first.record_count).toBe(180);
    expect(first.bucket_count).toBeGreaterThan(16);
    expect(first.largest_leaf_object_bytes).toBeLessThanOrEqual(520);
    const pointer = JSON.parse(await readFile(join(fixture.staticRoot, "current.json"), "utf8"));
    expect(verifyCatalogPointerSignature(pointer, {
      "catalog-production-2026": keys.publicKey,
    })).toEqual({ verified: true });
    const rootManifest = JSON.parse(await readFile(staticPath(fixture.staticRoot, pointer.root_manifest_url), "utf8"));
    expect(rootManifest.gate_a.report).toMatchObject({
      url: "/data/rock-catalog-v3/generations/full-fixture-v3/gate-a-report.json",
      compression: "identity",
    });
    await expect(readFile(staticPath(fixture.staticRoot, rootManifest.gate_a.report.url), "utf8"))
      .resolves.toContain('"status":"pass"');
    const namespaceEntry = rootManifest.namespaces.find(
      (entry: { namespace: string }) => entry.namespace === "artist-summary",
    );
    const namespaceManifest = JSON.parse(
      await readFile(staticPath(fixture.staticRoot, namespaceEntry.manifest.url), "utf8"),
    );
    expect(namespaceManifest.buckets).toEqual([]);
    expect(namespaceManifest.shards.length).toBeGreaterThan(0);
    const repository = new StaticShardedCatalogRepository(
      filesystemFetcher(fixture.staticRoot),
      { "catalog-production-2026": { jwk: keys.publicKey.export({ format: "jwk" }) as JsonWebKey } },
    );
    const session = await repository.openSession();
    await expect(repository.loadArtist("mw:artist:0179", session)).resolves.toMatchObject({
      entity_id: "mw:artist:0179",
      name: "Artist 179",
    });
  }, 20_000);

  test("rejects an oversized single record before switching current", async () => {
    const root = await mkdtemp(join(tmpdir(), "catalog-jsonl-v3-large-"));
    const fixture = await writeFixture(root, 1, pseudoRandomText(30_000));
    const keys = generateKeyPairSync("ed25519");

    await expect(publishCatalogJsonlV3({
      projection_manifest_path: fixture.manifestPath,
      static_root: fixture.staticRoot,
      key_id: "catalog-production-2026",
      private_key: keys.privateKey,
      published_at: "2026-09-01T00:01:00Z",
      gate_a_report_path: fixture.gateAReportPath,
      leaf_hard_limit_bytes: 520,
      publish_current: true,
    })).rejects.toThrow(/single record/iu);
    await expect(readFile(join(fixture.staticRoot, "current.json"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  test("rejects projection files that resolve outside the manifest directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "catalog-jsonl-v3-escape-"));
    const fixture = await writeFixture(root, 1);
    const projectionRoot = join(root, "projection");
    const externalRoot = join(root, "external");
    await mkdir(externalRoot);
    const namespaceBytes = await readFile(join(projectionRoot, "artist-summary.jsonl"));
    await writeFile(join(externalRoot, "artist-summary.jsonl"), namespaceBytes);
    await symlink(externalRoot, join(projectionRoot, "escape"));
    const projection = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
    projection.namespaces[0].path = "escape/artist-summary.jsonl";
    await writeFile(fixture.manifestPath, `${canonicalJsonV1(projection)}\n`);
    const keys = generateKeyPairSync("ed25519");

    await expect(publishCatalogJsonlV3({
      projection_manifest_path: fixture.manifestPath,
      static_root: fixture.staticRoot,
      key_id: "catalog-production-2026",
      private_key: keys.privateKey,
      published_at: "2026-09-01T00:01:00Z",
      gate_a_report_path: fixture.gateAReportPath,
      publish_current: false,
    })).rejects.toThrow(/outside projection root/iu);
  });
});

async function writeFixture(root: string, count: number, extra = "") {
  const projectionRoot = join(root, "projection");
  const staticRoot = join(root, "static");
  await mkdir(projectionRoot);
  const namespacePath = join(projectionRoot, "artist-summary.jsonl");
  const lines = Array.from({ length: count }, (_, index) => {
    const id = `mw:artist:${String(index).padStart(4, "0")}`;
    return `${canonicalJsonV1({ id, record: {
      entity_id: id,
      name: `Artist ${index}`,
      style_ids: [],
      source_url: null,
      extra: extra || pseudoRandomText(220, index + 1),
    } })}\n`;
  }).join("");
  await writeFile(namespacePath, lines);
  const overviewPath = join(projectionRoot, "overview.json");
  await writeFile(overviewPath, `${canonicalJsonV1({ styles: [], relations: [], layout: {} })}\n`);
  const gateAReportPath = join(projectionRoot, "gate-a-report.json");
  await writeFile(gateAReportPath, `${JSON.stringify({
    report_version: "3.0",
    gate: "A",
    status: "pass",
    readiness: { v3_architecture_ready: true, full_catalog_ready: false, graph_database_ready: false },
    blockers: [],
  })}\n`);
  const namespaceBytes = await readFile(namespacePath);
  const overviewBytes = await readFile(overviewPath);
  const { createHash } = await import("node:crypto");
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const manifest: PreparedCatalogProjectionV3 = {
    manifest_version: "3.0-prepared",
    projection_scope: "full-frontend",
    generation_id: "mw:catalog-generation:full-fixture-v3",
    generated_at: "2026-09-01T00:00:00Z",
    canonical_schema: "canon_fixture",
    database: "musicwiki",
    sources: [{ source: "fixture", snapshot_id: "fixture:1", license_partition: "fixture-cc0" }],
    counts: { canonical: { styles: 0, artists: count, release_groups: 0 }, projections: { overview_styles: 0 } },
    overview: { path: "overview.json", bytes: overviewBytes.byteLength, sha256: hash(overviewBytes) },
    namespaces: await Promise.all(FULL_FRONTEND_NAMESPACES.map(async (namespace) => {
      const path = `${namespace}.jsonl`;
      if (namespace !== "artist-summary") await writeFile(join(projectionRoot, path), "");
      const bytes = namespace === "artist-summary"
        ? namespaceBytes
        : await readFile(join(projectionRoot, path));
      return {
        namespace,
        path,
        record_count: namespace === "artist-summary" ? count : 0,
        bytes: bytes.byteLength,
        sha256: hash(bytes),
      };
    })),
    license_decision_ids: ["mw:license-decision:fixture-v1"],
    gate_a: {
      status: "pass",
      report_url: "/data/rock-catalog-v3/generations/full-fixture-v3/gate-a-report.json",
    },
  };
  const manifestPath = join(projectionRoot, "projection-manifest.json");
  await writeFile(manifestPath, `${canonicalJsonV1(manifest)}\n`);
  return { manifestPath, staticRoot, gateAReportPath };
}

function staticPath(root: string, url: string): string {
  return join(root, url.replace(/^\/data\/rock-catalog-v3\//u, ""));
}

function filesystemFetcher(root: string): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.pathname
        : new URL(input.url).pathname;
    try {
      const bytes = await readFile(staticPath(root, url));
      return new Response(bytes, { status: 200 });
    } catch {
      return new Response("not found", { status: 404 });
    }
  }) as typeof fetch;
}

function pseudoRandomText(length: number, seed = 0x12345678): string {
  let state = seed >>> 0;
  let output = "";
  for (let index = 0; index < length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    output += String.fromCharCode(33 + (state % 90));
  }
  return output;
}
