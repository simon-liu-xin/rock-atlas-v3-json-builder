import { describe, expect, test } from "vitest";

import {
  CATALOG_V3_CONTRACTS,
  canonicalJsonV1,
  isCatalogPointerCompatible,
  normalizeIdentityNameV1,
  normalizeSearchTextV1,
  normalizeSourceMatchTextV1,
  type CatalogClientCompatibility,
  type CatalogPointerV3,
} from "../../src/data/contracts/catalog-v3.ts";
import { validateSchemaDocument } from "../../src/data/schema-registry.ts";

const pointer: CatalogPointerV3 = {
  pointer_version: "3.0",
  channel: "rock-catalog-v3",
  generation_id: "mw:catalog-generation:fixture-v3",
  root_manifest_url:
    "/data/rock-catalog-v3/generations/fixture-v3/root-manifest.json",
  root_manifest_content_sha256: "a".repeat(64),
  root_manifest_object_sha256: "b".repeat(64),
  compatibility: {
    schema: { min: "3.0", max: "3.1" },
    layout: { min: "global-v1", max: "global-v1" },
    search_normalization: "search-normalization-v1",
    identity_normalization: "identity-normalization-v1",
    source_match_normalization: "source-match-normalization-v1",
    canonical_json: "canonical-json-v1",
  },
  published_at: "2026-08-17T00:00:00Z",
  key_id: "musicwiki-test-ed25519-2026",
  signature: "A".repeat(86),
};

describe("catalog V3 contract versions", () => {
  test("keeps search, identity and source matching normalization explicit", () => {
    expect(CATALOG_V3_CONTRACTS).toEqual({
      pointer: "3.0",
      schema: "3.0",
      layout: "global-v1",
      search_normalization: "search-normalization-v1",
      identity_normalization: "identity-normalization-v1",
      source_match_normalization: "source-match-normalization-v1",
      canonical_json: "canonical-json-v1",
    });

    expect(normalizeSearchTextV1("  ＰＯＳＴ－ＲＯＣＫ\tCafe\u0301  ")).toBe(
      "post-rock café",
    );
    expect(normalizeIdentityNameV1("  Siouxsie   &   the Banshees ")).toBe(
      "siouxsie & the banshees",
    );
    expect(normalizeSourceMatchTextV1("  SIGUR   RÓS  ")).toBe("sigur rós");
  });

  test("serializes canonical JSON with NFC strings and recursively sorted object keys", () => {
    const first = canonicalJsonV1({
      z: -0,
      name: "Cafe\u0301",
      nested: { beta: true, alpha: null },
      rows: [{ id: "b", value: 2 }, { value: 1, id: "a" }],
    });
    const second = canonicalJsonV1({
      rows: [{ value: 2, id: "b" }, { id: "a", value: 1 }],
      nested: { alpha: null, beta: true },
      name: "Café",
      z: 0,
    });

    expect(first).toBe(second);
    expect(first).toBe(
      '{"name":"Café","nested":{"alpha":null,"beta":true},"rows":[{"id":"b","value":2},{"id":"a","value":1}],"z":0}',
    );
    expect(() => canonicalJsonV1({ invalid: Number.NaN })).toThrow(
      "canonical-json-v1 only supports finite numbers",
    );
  });

  test("validates the V3 pointer schema", async () => {
    await expect(validateSchemaDocument("catalog-pointer-v3", pointer)).resolves.toBeUndefined();
    await expect(
      validateSchemaDocument("catalog-pointer-v3", { ...pointer, channel: "rock-catalog-v2" }),
    ).rejects.toMatchObject({ code: "MW_PACK_SCHEMA_INVALID" });
  });

  test("accepts only pointer generations inside the client contract", () => {
    const client: CatalogClientCompatibility = {
      schema_versions: ["3.0"],
      layout_versions: ["global-v1"],
      search_normalization_versions: ["search-normalization-v1"],
      identity_normalization_versions: ["identity-normalization-v1"],
      source_match_normalization_versions: ["source-match-normalization-v1"],
      canonical_json_versions: ["canonical-json-v1"],
    };

    expect(isCatalogPointerCompatible(pointer, client)).toEqual({ compatible: true });
    expect(
      isCatalogPointerCompatible(pointer, {
        ...client,
        schema_versions: ["4.0"],
      }),
    ).toEqual({
      compatible: false,
      reason: "schema version range 3.0..3.1 is unsupported",
    });
  });
});
