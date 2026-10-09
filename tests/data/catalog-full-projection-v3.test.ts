import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";

import {
  FULL_FRONTEND_NAMESPACES,
  FULL_OVERVIEW_RELATION_LIMIT,
  buildFullCatalogOverview,
  fullCatalogCountsSql,
  fullCatalogLegacyResolutionSql,
  fullCatalogNamespaceSql,
  fullCatalogSourcesSql,
} from "../../src/data/publication/catalog-full-projection-v3.ts";

describe("full catalog frontend projection V3", () => {
  test("exports every repository namespace from canonical tables without representative shortcuts", () => {
    expect(FULL_FRONTEND_NAMESPACES).toEqual([
      "style-summary",
      "style-artists",
      "style-relations",
      "artist-summary",
      "artist-release-groups",
      "release-group-summary",
      "relation",
      "evidence",
      "identity-resolution",
      "search-style",
      "search-artist",
      "search-release-group",
    ]);
    const sql = FULL_FRONTEND_NAMESPACES.map((namespace) =>
      fullCatalogNamespaceSql(namespace, "canon_fixture")
    ).join("\n");
    expect(sql).toContain('"canon_fixture".artist_style_qualification');
    expect(sql).toContain('"canon_fixture".release_group_artist');
    expect(sql).toContain("floor(row_index / 60)");
    expect(sql).toContain("floor(row_index / 24)");
    expect(sql).toContain("normalize(canonical_name, NFKC)");
    expect(sql).not.toContain("style_representative_artist");
    expect(sql).not.toContain("style_representative_release_group");
    expect(() => fullCatalogCountsSql("bad-schema;drop")).toThrow(/invalid canonical schema/iu);
    expect(fullCatalogSourcesSql("canon_fixture")).toContain('"canon_fixture".source_snapshot');
  });

  test("streams raw psql rows without COPY text escaping", async () => {
    const runner = await readFile("scripts/offline-data/export_full_frontend_jsonl.mjs", "utf8");
    expect(runner).toContain('"-X", "-qAt"');
    expect(runner).not.toContain("COPY (${sql.trim()}) TO STDOUT");
  });

  test("resolves legacy IDs only through accepted external identities", () => {
    const sql = fullCatalogLegacyResolutionSql("canon_fixture", [{
      from_id: "mw:style:grunge",
      namespace: "wikidata-item",
      external_id: "Q11365",
    }]);
    expect(sql).toContain('JOIN "canon_fixture".external_identity');
    expect(sql).toContain("identity.assertion_status = 'accepted'");
    expect(sql).toContain("HAVING count(DISTINCT identity.internal_id) = 1");
    expect(() => fullCatalogLegacyResolutionSql("canon_fixture", [{
      from_id: "mw:style:bad';drop",
      namespace: "wikidata-item",
      external_id: "Q1",
    }])).toThrow(/invalid legacy identity/iu);
  });

  test("builds a deterministic bounded global layout", () => {
    const styles = Array.from({ length: 828 }, (_, index) => ({
      entity_id: index === 0 ? "mw:style:rock" : `mw:style:wikidata:q${index}`,
      name: index === 0 ? "Rock" : `Style ${index}`,
      era: null,
      region: null,
      source_url: null,
      artist_count: index,
    }));
    const first = buildFullCatalogOverview(styles, [], "mw:catalog-generation:fixture");
    const second = buildFullCatalogOverview(styles, [], "mw:catalog-generation:fixture");
    expect(first).toEqual(second);
    expect(first.layout["mw:style:rock"]).toEqual({ x: 0, y: 0, z: 0 });
    expect(Math.max(...Object.values(first.layout).map((point) => Math.abs(point.x))))
      .toBeLessThanOrEqual(5.94);
    expect(Math.max(...Object.values(first.layout).map((point) => Math.abs(point.y))))
      .toBeLessThanOrEqual(2.05);
  });

  test("bounds overview topology while retaining the complete relation namespace", () => {
    const relations = Array.from({ length: FULL_OVERVIEW_RELATION_LIMIT + 50 }, (_, index) => ({
      entity_id: `mw:relation:${String(index).padStart(4, "0")}`,
      relation_type: index % 2 === 0 ? "subgenre_of" : "associated_with",
      direction: index % 2 === 0 ? "directed" as const : "undirected" as const,
      participants: [],
      assertion_kind: index % 3 === 0 ? "fact" as const : "candidate" as const,
    }));
    const overview = buildFullCatalogOverview([], relations, "mw:catalog-generation:fixture");
    expect(overview.relations).toHaveLength(FULL_OVERVIEW_RELATION_LIMIT);
    expect((overview.relations[0] as unknown as { assertion_kind: string }).assertion_kind).toBe("fact");
  });
});
