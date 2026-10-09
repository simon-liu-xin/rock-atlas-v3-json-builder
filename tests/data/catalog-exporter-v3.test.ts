import { generateKeyPairSync } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  buildCatalogExportV3,
  verifyCatalogExportBundle,
} from "../../src/data/publication/catalog-exporter-v3.ts";
import { verifyCatalogPointerSignature } from "../../src/data/publication/catalog-signature.ts";
import { validateSchemaDocument } from "../../src/data/schema-registry.ts";

const signingKey = generateKeyPairSync("ed25519");

describe("catalog V3 exporter", () => {
  test("rebuilds deterministically, splits by actual gzip bytes and verifies the hash tree", async () => {
    const input = fixtureInput();
    const first = buildCatalogExportV3(input);
    const second = buildCatalogExportV3(input);

    expect(first.pointer_bytes).toEqual(second.pointer_bytes);
    expect(first.artifacts.map((artifact) => artifact.bytes)).toEqual(
      second.artifacts.map((artifact) => artifact.bytes),
    );
    expect(first.root_manifest).toEqual(second.root_manifest);
    expect(first.report.bucket_count).toBeGreaterThan(1);
    expect(first.report.largest_leaf_object_bytes).toBeLessThanOrEqual(360);
    expect(first.artifacts.filter((artifact) => artifact.kind === "leaf").every(
      (artifact) => artifact.bytes.byteLength <= 360,
    )).toBe(true);
    expect(() => verifyCatalogExportBundle(first)).not.toThrow();
    expect(
      verifyCatalogPointerSignature(first.pointer, {
        "catalog-test-2026": signingKey.publicKey,
      }),
    ).toEqual({ verified: true });
    expect(
      verifyCatalogPointerSignature({ ...first.pointer, signature: "A".repeat(86) }, {
        "catalog-test-2026": signingKey.publicKey,
      }),
    ).toMatchObject({ verified: false });
    await expect(validateSchemaDocument("catalog-pointer-v3", first.pointer)).resolves.toBeUndefined();
    await expect(
      validateSchemaDocument("catalog-root-manifest-v3", first.root_manifest),
    ).resolves.toBeUndefined();
    for (const entry of first.root_manifest.namespaces) {
      const artifact = first.artifacts.find((candidate) => candidate.url === entry.manifest.url);
      expect(artifact).toBeDefined();
      await expect(validateSchemaDocument(
        "catalog-namespace-manifest-v3",
        JSON.parse(Buffer.from(artifact!.bytes).toString("utf8")),
      )).resolves.toBeUndefined();
    }
  });

  test("rejects an oversized indivisible record and tampered artifact bytes", () => {
    expect(() =>
      buildCatalogExportV3({
        ...fixtureInput(),
        leaf_hard_limit_bytes: 120,
        namespaces: {
          "artist-summary": {
            "mw:artist:oversized": { name: pseudoRandomText(4_000) },
          },
        },
      }),
    ).toThrow(/single record .* exceeds leaf hard limit/u);

    const bundle = buildCatalogExportV3(fixtureInput());
    const artifact = bundle.artifacts.find((entry) => entry.kind === "leaf");
    expect(artifact).toBeDefined();
    const tampered = {
      ...bundle,
      artifacts: bundle.artifacts.map((entry) =>
        entry === artifact ? { ...entry, bytes: Buffer.from("tampered") } : entry,
      ),
    };
    expect(() => verifyCatalogExportBundle(tampered)).toThrow(/object sha-256 mismatch/iu);
  });
});

function fixtureInput() {
  const records = Object.fromEntries(
    Array.from({ length: 48 }, (_, index) => [
      `mw:artist:${String(index).padStart(3, "0")}`,
      { name: `Artist ${index}`, biography: pseudoRandomText(120 + index) },
    ]),
  );
  return {
    generation_id: "mw:catalog-generation:fixture-v3",
    generated_at: "2026-08-17T00:00:00.000Z",
    published_at: "2026-08-17T00:01:00.000Z",
    sources: [
      { source: "fixture", snapshot_id: "fixture:20260817", license_partition: "fixture-cc0" },
    ],
    counts: {
      canonical: { styles: 2, artists: 48, release_groups: 48 },
      projections: { overview_styles: 2 },
    },
    overview: { styles: [{ id: "mw:style:rock", label: "Rock" }] },
    namespaces: { "artist-summary": records },
    license_decision_ids: ["mw:license-decision:fixture-v1"],
    gate_a: { status: "not-run" as const, report_url: null },
    leaf_hard_limit_bytes: 360,
    key_id: "catalog-test-2026",
    private_key: signingKey.privateKey,
  };
}

function pseudoRandomText(length: number): string {
  let value = 0x12345678;
  let output = "";
  for (let index = 0; index < length; index += 1) {
    value = (value * 1664525 + 1013904223) >>> 0;
    output += String.fromCharCode(33 + (value % 90));
  }
  return output;
}
