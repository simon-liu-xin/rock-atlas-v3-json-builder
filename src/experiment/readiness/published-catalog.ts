import type { ExperimentSample } from "../viewmodel/candidate-model.ts";
import { validateStyleRelationV2 } from "../../data/relations/style-relation-v2.ts";

export const PUBLISHED_CATALOG_POINTER_URL = "/data/rock-catalog-v2/current.json";

export async function fetchPublishedCatalog(
  fetcher: typeof fetch = fetch,
): Promise<ExperimentSample> {
  const pointerResponse = await fetcher(PUBLISHED_CATALOG_POINTER_URL, {
    headers: { accept: "application/json", "cache-control": "no-cache" },
  });
  if (!pointerResponse.ok) {
    throw new Error(`Published catalog pointer returned HTTP ${pointerResponse.status}.`);
  }
  const pointer = validateCatalogPointer(await pointerResponse.json());
  const response = await fetcher(pointer.catalog_url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Published catalog returned HTTP ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (await sha256(bytes) !== pointer.catalog_sha256) {
    throw new Error("Published catalog hash does not match its current pointer.");
  }
  const catalog = validatePublishedCatalog(JSON.parse(new TextDecoder().decode(bytes)));
  if (catalog.snapshot_id !== pointer.generation_id) {
    throw new Error("Published catalog generation does not match its current pointer.");
  }
  return catalog;
}

export function validatePublishedCatalog(value: unknown): ExperimentSample {
  if (!isRecord(value) || value.schema_version !== "1.0" || value.catalog_version !== "2.0") {
    throw new Error("Published catalog has an unsupported schema version.");
  }
  const sample = value as unknown as ExperimentSample;
  if (
    !Array.isArray(sample.styles) ||
    !Array.isArray(sample.artists) ||
    !Array.isArray(sample.release_groups) ||
    sample.styles.length === 0 ||
    sample.artists.length !== sample.styles.length ||
    sample.release_groups.length !== sample.styles.length
  ) {
    throw new Error(
      "Published catalog styles, artist occurrences, and release-group occurrences must have the same non-zero cardinality.",
    );
  }
  const styleIds = uniqueIds(sample.styles, "style");
  const artistIds = uniqueIds(sample.artists, "artist");
  uniqueIds(sample.release_groups, "release group");
  const releasesByArtist = new Map<string, number>();
  for (const release of sample.release_groups) {
    if (release.artist_ids.length !== 1 || !artistIds.has(release.artist_ids[0]!)) {
      throw new Error(`Release group ${release.internal_id} has an invalid artist occurrence.`);
    }
    validateSourceValidation(release);
    releasesByArtist.set(release.artist_ids[0]!, (releasesByArtist.get(release.artist_ids[0]!) ?? 0) + 1);
  }
  for (const style of sample.styles) {
    if (style.artist_ids.length !== 1 || !artistIds.has(style.artist_ids[0]!)) {
      throw new Error(`Style ${style.internal_id} has an invalid representative artist occurrence.`);
    }
  }
  for (const artist of sample.artists) {
    if (!styleIds.has(artist.style_id) || releasesByArtist.get(artist.internal_id) !== 1) {
      throw new Error(`Artist occurrence ${artist.internal_id} violates the one-style/one-release projection.`);
    }
    if (artist.canonical_name.includes("Mock representative") || artist.source_url.includes("example.invalid")) {
      throw new Error(`Artist occurrence ${artist.internal_id} is not backed by a real source.`);
    }
    validateSourceValidation(artist);
  }
  if (!sample.style_relations_v2) throw new Error("Published catalog has no Graph V2 relations.");
  for (const assertion of sample.style_relations_v2) {
    validateStyleRelationV2(assertion);
    if (assertion.participants.some((participant) => !styleIds.has(participant.style_id))) {
      throw new Error(`Graph relation ${assertion.relation_id} references an unpublished style.`);
    }
  }
  return sample;
}

function validateSourceValidation(entity: {
  internal_id: string;
  validation_status?: string;
  verified_sources?: string[];
}): void {
  const acceptedStatuses = new Set(["cross_verified", "single_source", "curated"]);
  if (!entity.validation_status || !acceptedStatuses.has(entity.validation_status) ||
      !Array.isArray(entity.verified_sources) || entity.verified_sources.length === 0) {
    throw new Error(`Published entity ${entity.internal_id} is missing source validation metadata.`);
  }
  if (entity.validation_status === "cross_verified" && entity.verified_sources.length < 2) {
    throw new Error(`Published entity ${entity.internal_id} is not actually cross-verified.`);
  }
}

function uniqueIds<T extends { internal_id: string }>(values: T[], kind: string): Set<string> {
  const result = new Set(values.map((value) => value.internal_id));
  if (result.size !== values.length) throw new Error(`Published catalog contains duplicate ${kind} IDs.`);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateCatalogPointer(value: unknown): {
  generation_id: string;
  catalog_url: string;
  catalog_sha256: string;
} {
  if (!isRecord(value) ||
      typeof value.generation_id !== "string" ||
      typeof value.catalog_url !== "string" ||
      typeof value.catalog_sha256 !== "string" ||
      !/^rock-catalog-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/.test(value.generation_id) ||
      !/^\/data\/rock-catalog-v2\/generations\/rock-catalog-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}\.json$/.test(value.catalog_url) ||
      !/^[a-f0-9]{64}$/.test(value.catalog_sha256)) {
    throw new Error("Published catalog pointer is invalid.");
  }
  return value as {
    generation_id: string;
    catalog_url: string;
    catalog_sha256: string;
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
