import type { CatalogSession } from "./catalog-session.ts";

export interface StyleSummary {
  readonly entity_id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly era: string | null;
  readonly region: string | null;
  readonly source_url: string | null;
  readonly artist_count: number;
  readonly parent_style_ids?: readonly string[];
  readonly path_id?: string | null;
}

export interface ArtistSummary {
  readonly entity_id: string;
  readonly name: string;
  readonly style_ids: readonly string[];
  readonly presentation_style_ids?: readonly string[];
  readonly source_url: string | null;
  readonly description?: string | null;
  readonly artist_type?: string | null;
  readonly begin_date?: string | null;
  readonly end_date?: string | null;
  readonly country_code?: string | null;
}

export interface ReleaseGroupSummary {
  readonly entity_id: string;
  readonly name: string;
  readonly artist_ids: readonly string[];
  readonly primary_type: string | null;
  readonly secondary_types: readonly string[];
  readonly first_release_date: string | null;
  readonly source_url: string | null;
  readonly description?: string | null;
  readonly cover_art_url?: string | null;
}

export interface RelationDetail {
  readonly entity_id: string;
  readonly relation_type: string;
  readonly direction: "directed" | "undirected";
  readonly participants: readonly {
    readonly style_id: string;
    readonly role: "source" | "target" | "peer";
    readonly ordinal: number;
  }[];
  readonly assertion_kind?: "fact" | "inferred" | "candidate";
  readonly confidence_band?: "low" | "medium" | "high";
  readonly source_datasets?: readonly string[];
  readonly evidence_ids?: readonly string[];
  readonly label?: string;
  readonly summary?: string;
  readonly assertion?: import('../../generated/schema-types.ts').StyleRelationAssertionV2;
}

export interface UniverseOverview {
  readonly styles: readonly StyleSummary[];
  readonly relations: readonly RelationDetail[];
  readonly layout: Readonly<Record<string, { readonly x: number; readonly y: number; readonly z: number }>>;
  readonly particle_seed?: number;
}

export interface SearchResult {
  readonly entity_id: string;
  readonly entity_type: "style" | "artist" | "release-group";
  readonly name: string;
  readonly match_kind: "exact" | "prefix" | "contains";
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
}

export type EntityResolution =
  | { readonly status: "current"; readonly entity_id: string }
  | { readonly status: "redirected"; readonly from_id: string; readonly entity_id: string }
  | { readonly status: "removed"; readonly entity_id: string; readonly reason?: string }
  | {
      readonly status: "split";
      readonly from_id: string;
      readonly candidates: readonly { readonly entity_id: string; readonly name: string }[];
    };

export interface SearchOptions {
  readonly entity_types?: readonly SearchResult["entity_type"][];
  readonly limit?: number;
}

export interface CatalogRepository {
  openSession(signal?: AbortSignal): Promise<CatalogSession>;
  resolveEntityId(id: string, session: CatalogSession): Promise<EntityResolution>;
  searchEntities(query: string, options: SearchOptions, session: CatalogSession): Promise<Page<SearchResult>>;
  loadOverview(session: CatalogSession): Promise<UniverseOverview>;
  loadStyle(id: string, session: CatalogSession): Promise<StyleSummary>;
  loadStyleArtists(id: string, cursor: string | null, session: CatalogSession): Promise<Page<ArtistSummary>>;
  loadStyleRelations(id: string, cursor: string | null, session: CatalogSession): Promise<Page<RelationDetail>>;
  loadArtist(id: string, session: CatalogSession): Promise<ArtistSummary>;
  loadArtistReleaseGroups(id: string, cursor: string | null, session: CatalogSession): Promise<Page<ReleaseGroupSummary>>;
  loadReleaseGroup(id: string, session: CatalogSession): Promise<ReleaseGroupSummary>;
  loadRelation(id: string, session: CatalogSession): Promise<RelationDetail>;
}

export interface CatalogCursorV1 {
  readonly cursor_version: "catalog-cursor-v1";
  readonly generation_id: string;
  readonly collection: string;
  readonly offset: number;
}

export function encodeCatalogCursor(cursor: CatalogCursorV1): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeCatalogCursor(
  cursor: string | null,
  session: CatalogSession,
  collection: string,
): number {
  if (cursor === null) return 0;
  let value: unknown;
  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    value = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0))));
  } catch {
    throw new Error("Catalog cursor is malformed");
  }
  if (!isRecord(value) || value.cursor_version !== "catalog-cursor-v1" ||
      value.generation_id !== session.generation_id) {
    throw new Error("stale-generation");
  }
  if (value.collection !== collection || !Number.isInteger(value.offset) || Number(value.offset) < 0) {
    throw new Error("Catalog cursor does not match this collection");
  }
  return Number(value.offset);
}

export function pageCatalogItems<T>(input: {
  readonly items: readonly T[];
  readonly limit: number;
  readonly offset: number;
  readonly session: CatalogSession;
  readonly collection: string;
}): Page<T> {
  const items = input.items.slice(input.offset, input.offset + input.limit);
  const nextOffset = input.offset + items.length;
  return {
    items,
    next_cursor: nextOffset < input.items.length
      ? encodeCatalogCursor({
          cursor_version: "catalog-cursor-v1",
          generation_id: input.session.generation_id,
          collection: input.collection,
          offset: nextOffset,
        })
      : null,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
