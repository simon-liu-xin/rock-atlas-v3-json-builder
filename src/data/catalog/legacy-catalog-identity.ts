import type { LegacyIdentityCandidate } from "../publication/catalog-full-projection-v3.ts";

export interface LegacyCatalogIdentityInput {
  readonly generation_id: string;
  readonly candidates: readonly LegacyIdentityCandidate[];
  readonly unresolved_ids: readonly string[];
}

export function parseLegacyCatalogIdentityInput(value: unknown): LegacyCatalogIdentityInput {
  const catalog = asRecord(value);
  if (catalog.schema_version !== "2.0" || typeof catalog.generation_id !== "string" ||
      !catalog.generation_id || !Array.isArray(catalog.styles) ||
      !Array.isArray(catalog.artists) || !Array.isArray(catalog.release_groups)) {
    throw new Error("Legacy catalog identity contract mismatch");
  }
  const candidates: LegacyIdentityCandidate[] = [];
  const unresolvedIds: string[] = [];
  const seen = new Set<string>();
  for (const raw of catalog.styles) addCandidate(raw, "wikidata-item", "wikidata_qid");
  for (const raw of catalog.artists) addCandidate(raw, "musicbrainz-artist", "musicbrainz_mbid");
  for (const raw of catalog.release_groups) {
    addCandidate(raw, "musicbrainz-release-group", "musicbrainz_mbid");
  }
  candidates.sort((left, right) => left.from_id.localeCompare(right.from_id, "en-US"));
  unresolvedIds.sort((left, right) => left.localeCompare(right, "en-US"));
  return {
    generation_id: catalog.generation_id,
    candidates,
    unresolved_ids: unresolvedIds,
  };

  function addCandidate(
    raw: unknown,
    namespace: LegacyIdentityCandidate["namespace"],
    externalField: string,
  ): void {
    const entity = asRecord(raw);
    if (typeof entity.internal_id !== "string" ||
        !/^mw:(?:style|artist|release-group):[a-z0-9][a-z0-9._:-]*$/u.test(entity.internal_id) ||
        seen.has(entity.internal_id)) {
      throw new Error("Legacy catalog contains an invalid or duplicate internal ID");
    }
    seen.add(entity.internal_id);
    const externalId = entity[externalField];
    if (typeof externalId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(externalId)) {
      unresolvedIds.push(entity.internal_id);
      return;
    }
    candidates.push({ from_id: entity.internal_id, namespace, external_id: externalId });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
