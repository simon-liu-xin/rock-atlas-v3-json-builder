import { canonicalJsonV1, isCatalogPointerCompatible, normalizeSearchTextV1, type CatalogPointerV3 } from "../contracts/catalog-v3.ts";
import type { CatalogNamespaceManifestV3, CatalogObjectEntryV3, CatalogRootManifestV3 } from "../publication/catalog-exporter-v3.ts";
import {
  decodeCatalogCursor,
  encodeCatalogCursor,
  isRecord,
  pageCatalogItems,
  type ArtistSummary,
  type CatalogRepository,
  type EntityResolution,
  type Page,
  type RelationDetail,
  type ReleaseGroupSummary,
  type SearchOptions,
  type SearchResult,
  type StyleSummary,
  type UniverseOverview,
} from "./catalog-repository.ts";
import { CatalogSession } from "./catalog-session.ts";

export interface BrowserCatalogSigningKey {
  readonly jwk: JsonWebKey;
  readonly not_before?: string;
  readonly not_after?: string;
}

interface V3SessionState {
  readonly root: CatalogRootManifestV3;
  readonly pointer: CatalogPointerV3;
}

const SESSION_STATE = "v3:session-state";

export class StaticShardedCatalogRepository implements CatalogRepository {
  constructor(
    private readonly fetcher: typeof fetch,
    private readonly trustedKeys: Readonly<Record<string, BrowserCatalogSigningKey>>,
    private readonly pointerUrl = "/data/rock-catalog-v3/current.json",
  ) {}

  async openSession(signal?: AbortSignal): Promise<CatalogSession> {
    const pointer = await this.#fetchJson<CatalogPointerV3>(this.pointerUrl, signal, true);
    assertPointer(pointer);
    await verifyBrowserPointerSignature(pointer, this.trustedKeys);
    const compatibility = isCatalogPointerCompatible(pointer, {
      schema_versions: ["3.0"],
      layout_versions: ["global-v1"],
      search_normalization_versions: ["search-normalization-v1"],
      identity_normalization_versions: ["identity-normalization-v1"],
      source_match_normalization_versions: ["source-match-normalization-v1"],
      canonical_json_versions: ["canonical-json-v1"],
    });
    if (!compatibility.compatible) throw new Error(`Catalog pointer is incompatible: ${compatibility.reason}`);
    const rootBytes = await this.#fetchBytes(pointer.root_manifest_url, signal, true);
    if (await sha256Hex(rootBytes) !== pointer.root_manifest_object_sha256 ||
        await sha256Hex(rootBytes) !== pointer.root_manifest_content_sha256) {
      throw new Error("Catalog root manifest hash does not match its signed pointer");
    }
    const root = parseJson<CatalogRootManifestV3>(rootBytes, "catalog root manifest");
    assertRoot(root, pointer);
    const session = new CatalogSession(pointer.generation_id, "rock-catalog-v3", root.schema_version, root.layout_version, {
      search: root.normalization.search,
      identity: root.normalization.identity,
      source_match: root.normalization.source_match,
      canonical_json: root.canonical_json_version,
    });
    session.cache.set(SESSION_STATE, { pointer, root } satisfies V3SessionState);
    return session;
  }

  async resolveEntityId(id: string, session: CatalogSession): Promise<EntityResolution> {
    const resolution = await this.#loadRecordOptional<EntityResolution>("identity-resolution", id, session);
    return resolution ?? { status: "current", entity_id: id };
  }

  async searchEntities(query: string, options: SearchOptions, session: CatalogSession): Promise<Page<SearchResult>> {
    session.assertActive();
    const normalized = normalizeSearchTextV1(query);
    if (!normalized) return { items: [], next_cursor: null };
    const keys = [
      { key: `exact:${normalized}`, kind: "exact" as const },
      { key: `prefix:${normalized}`, kind: "prefix" as const },
      ...grams(normalized).map((gram) => ({ key: `gram:${gram}`, kind: "contains" as const })),
    ];
    const namespaces = ["search-style", "search-artist", "search-release-group"] as const;
    const allowed = new Set(options.entity_types ?? ["style", "artist", "release-group"]);
    const byId = new Map<string, SearchResult>();
    for (const namespace of namespaces) {
      const entityType = namespace === "search-style" ? "style" : namespace === "search-artist" ? "artist" : "release-group";
      if (!allowed.has(entityType)) continue;
      for (const { key, kind } of keys.filter((entry) => entry.kind !== "contains")) {
        const index = await this.#loadRecordOptional<{ results: readonly { entity_id: string; name: string }[] }>(namespace, key, session);
        for (const result of index?.results ?? []) {
          const current = byId.get(result.entity_id);
          if (!current || matchRank(kind) < matchRank(current.match_kind)) {
            byId.set(result.entity_id, { ...result, entity_type: entityType, match_kind: kind });
          }
        }
      }
      const gramKeys = keys.filter((entry) => entry.kind === "contains");
      const gramHits = new Map<string, { count: number; name: string }>();
      for (const { key } of gramKeys) {
        const index = await this.#loadRecordOptional<{
          results: readonly { entity_id: string; name: string }[];
        }>(namespace, key, session);
        const seen = new Set<string>();
        for (const result of index?.results ?? []) {
          if (seen.has(result.entity_id)) continue;
          seen.add(result.entity_id);
          const current = gramHits.get(result.entity_id);
          gramHits.set(result.entity_id, {
            count: (current?.count ?? 0) + 1,
            name: result.name,
          });
        }
      }
      for (const [entityId, hit] of gramHits) {
        if (hit.count !== gramKeys.length || byId.has(entityId)) continue;
        byId.set(entityId, {
          entity_id: entityId,
          entity_type: entityType,
          name: hit.name,
          match_kind: "contains",
        });
      }
    }
    const results = [...byId.values()].sort((left, right) =>
      matchRank(left.match_kind) - matchRank(right.match_kind) ||
      typeRank(left.entity_type) - typeRank(right.entity_type) ||
      normalizeSearchTextV1(left.name).localeCompare(normalizeSearchTextV1(right.name), "en-US") ||
      left.entity_id.localeCompare(right.entity_id, "en-US"),
    );
    return { items: results.slice(0, options.limit ?? 20), next_cursor: null };
  }

  async loadOverview(session: CatalogSession): Promise<UniverseOverview> {
    const state = this.#state(session);
    return this.#fetchObject<UniverseOverview>(state.root.overview, session, "overview");
  }

  catalogCounts(session: CatalogSession): CatalogRootManifestV3['counts'] {
    return this.#state(session).root.counts;
  }

  async loadStyle(id: string, session: CatalogSession): Promise<StyleSummary> {
    return this.#loadRequiredRecord("style-summary", id, session);
  }

  async loadStyleArtists(id: string, cursor: string | null, session: CatalogSession): Promise<Page<ArtistSummary>> {
    const collection = `style-artists:${id}`;
    const offset = decodeCatalogCursor(cursor, session, collection);
    const pageRecord = await this.#loadRecordOptional<{
      items: readonly ArtistSummary[];
      next_offset: number | null;
    }>("style-artists", `${id}:page:${Math.floor(offset / 60)}`, session);
    if (pageRecord) return catalogProjectionPage(pageRecord, session, collection);
    const record = await this.#loadRequiredRecord<{ items: readonly ArtistSummary[] }>("style-artists", id, session);
    return pageCatalogItems({
      items: record.items,
      limit: 60,
      offset,
      session,
      collection,
    });
  }

  async loadArtist(id: string, session: CatalogSession): Promise<ArtistSummary> {
    return this.#loadRequiredRecord("artist-summary", id, session);
  }

  async loadStyleRelations(id: string, cursor: string | null, session: CatalogSession): Promise<Page<RelationDetail>> {
    const collection = `style-relations:${id}`;
    const offset = decodeCatalogCursor(cursor, session, collection);
    if (offset % 60 !== 0) throw new Error(`Catalog cursor is not aligned to ${collection}`);
    const pageRecord = await this.#loadRequiredRecord<{
      items: readonly RelationDetail[];
      next_offset: number | null;
    }>("style-relations", `${id}:page:${Math.floor(offset / 60)}`, session);
    return catalogProjectionPage(pageRecord, session, collection);
  }

  async loadArtistReleaseGroups(id: string, cursor: string | null, session: CatalogSession): Promise<Page<ReleaseGroupSummary>> {
    const collection = `artist-release-groups:${id}`;
    const offset = decodeCatalogCursor(cursor, session, collection);
    const pageRecord = await this.#loadRecordOptional<{
      items: readonly ReleaseGroupSummary[];
      next_offset: number | null;
    }>("artist-release-groups", `${id}:page:${Math.floor(offset / 24)}`, session);
    if (pageRecord) return catalogProjectionPage(pageRecord, session, collection);
    const record = await this.#loadRequiredRecord<{ items: readonly ReleaseGroupSummary[] }>("artist-release-groups", id, session);
    return pageCatalogItems({
      items: record.items,
      limit: 24,
      offset,
      session,
      collection,
    });
  }

  async loadReleaseGroup(id: string, session: CatalogSession): Promise<ReleaseGroupSummary> {
    return this.#loadRequiredRecord("release-group-summary", id, session);
  }

  async loadRelation(id: string, session: CatalogSession): Promise<RelationDetail> {
    return this.#loadRequiredRecord("relation", id, session);
  }

  async #loadRequiredRecord<T>(namespace: string, id: string, session: CatalogSession): Promise<T> {
    const value = await this.#loadRecordOptional<T>(namespace, id, session);
    if (value === null) throw new Error(`Catalog ${namespace} record not found: ${id}`);
    return value;
  }

  async #loadRecordOptional<T>(namespace: string, id: string, session: CatalogSession): Promise<T | null> {
    const manifestEntry = this.#state(session).root.namespaces.find((entry) => entry.namespace === namespace);
    if (!manifestEntry) return null;
    const manifest = await this.#fetchObject<CatalogNamespaceManifestV3>(manifestEntry.manifest, session, `manifest:${namespace}`);
    const hash = await sha256Hex(new TextEncoder().encode(id.normalize("NFC")));
    const leafManifest = await this.#resolveNamespaceManifest(manifest, namespace, hash, session);
    const bucket = [...leafManifest.buckets]
      .filter((entry) => hash.startsWith(entry.prefix))
      .sort((left, right) => right.prefix.length - left.prefix.length)[0];
    if (!bucket) return null;
    const payload = await this.#fetchObject<{ records: Readonly<Record<string, T>> }>(
      { ...bucket, compression: "gzip" }, session, `bucket:${namespace}:${bucket.prefix}`,
    );
    return payload.records[id] ?? null;
  }

  async #resolveNamespaceManifest(
    initial: CatalogNamespaceManifestV3,
    namespace: string,
    hash: string,
    session: CatalogSession,
  ): Promise<CatalogNamespaceManifestV3> {
    let manifest = initial;
    for (let depth = 0; depth <= 64; depth += 1) {
      if (manifest.generation_id !== session.generation_id || manifest.namespace !== namespace ||
          (manifest.prefix !== undefined && !hash.startsWith(manifest.prefix))) {
        throw new Error(`Catalog namespace manifest identity mismatch: ${namespace}`);
      }
      const shard = [...(manifest.shards ?? [])]
        .filter((entry) => hash.startsWith(entry.prefix))
        .sort((left, right) => right.prefix.length - left.prefix.length)[0];
      if (!shard) return manifest;
      manifest = await this.#fetchObject<CatalogNamespaceManifestV3>(
        shard.manifest,
        session,
        `manifest:${namespace}:${shard.prefix}`,
      );
    }
    throw new Error(`Catalog namespace manifest routing exceeds 64 levels: ${namespace}`);
  }

  async #fetchObject<T>(
    entry: CatalogObjectEntryV3,
    session: CatalogSession,
    cacheKey: string,
  ): Promise<T> {
    session.assertActive();
    const cached = session.cache.get(cacheKey);
    if (cached !== undefined) return cached as T;
    const existing = session.inFlight.get(cacheKey);
    if (existing) return existing as Promise<T>;
    const pending = (async () => {
      const objectBytes = await this.#fetchBytes(entry.url, session.abortController.signal, false);
      if (objectBytes.byteLength !== entry.object_bytes || await sha256Hex(objectBytes) !== entry.object_sha256) {
        throw new Error(`Catalog object hash mismatch for ${entry.url}`);
      }
      const content = entry.compression === "gzip" ? await gunzip(objectBytes) : objectBytes;
      if (content.byteLength !== entry.content_bytes || await sha256Hex(content) !== entry.content_sha256) {
        throw new Error(`Catalog content hash mismatch for ${entry.url}`);
      }
      const value = parseJson<T>(content, entry.url);
      session.assertActive();
      session.cache.set(cacheKey, value);
      return value;
    })();
    session.inFlight.set(cacheKey, pending);
    try {
      return await pending;
    } finally {
      session.inFlight.delete(cacheKey);
    }
  }

  #state(session: CatalogSession): V3SessionState {
    session.assertActive();
    if (session.channel !== "rock-catalog-v3") throw new Error("Catalog session channel mismatch");
    const state = session.cache.get(SESSION_STATE);
    if (!state) throw new Error("V3 catalog session has no verified manifest state");
    return state as V3SessionState;
  }

  async #fetchJson<T>(url: string, signal: AbortSignal | undefined, noCache: boolean): Promise<T> {
    return parseJson<T>(await this.#fetchBytes(url, signal, noCache), url);
  }

  async #fetchBytes(url: string, signal: AbortSignal | undefined, noCache: boolean): Promise<Uint8Array> {
    const fetcher = this.fetcher;
    const response = await fetcher(url, {
      ...(signal ? { signal } : {}),
      headers: { accept: "application/json", ...(noCache ? { "cache-control": "no-cache" } : {}) },
    });
    if (!response.ok) throw new Error(`Catalog request ${url} returned HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

function catalogProjectionPage<T>(
  record: { readonly items: readonly T[]; readonly next_offset: number | null },
  session: CatalogSession,
  collection: string,
): Page<T> {
  if (record.next_offset !== null &&
      (!Number.isSafeInteger(record.next_offset) || record.next_offset < 1)) {
    throw new Error(`Catalog projection page has an invalid next offset: ${collection}`);
  }
  return {
    items: record.items,
    next_cursor: record.next_offset === null ? null : encodeCatalogCursor({
      cursor_version: "catalog-cursor-v1",
      generation_id: session.generation_id,
      collection,
      offset: record.next_offset,
    }),
  };
}

async function verifyBrowserPointerSignature(
  pointer: CatalogPointerV3,
  keys: Readonly<Record<string, BrowserCatalogSigningKey>>,
): Promise<void> {
  const key = keys[pointer.key_id];
  if (!key) throw new Error(`Unknown catalog signing key ${pointer.key_id}`);
  const now = Date.now();
  if (key.not_before && now < Date.parse(key.not_before)) throw new Error(`Catalog signing key ${pointer.key_id} is not active`);
  if (key.not_after && now > Date.parse(key.not_after)) throw new Error(`Catalog signing key ${pointer.key_id} is expired`);
  const cryptoKey = await crypto.subtle.importKey("jwk", key.jwk, { name: "Ed25519" }, false, ["verify"]);
  const { signature, ...unsigned } = pointer;
  const valid = await crypto.subtle.verify(
    { name: "Ed25519" },
    cryptoKey,
    base64UrlBytes(signature).buffer as ArrayBuffer,
    new TextEncoder().encode(canonicalJsonV1(unsigned)),
  );
  if (!valid) throw new Error("Catalog pointer signature verification failed");
}

function assertPointer(value: CatalogPointerV3): void {
  if (!isRecord(value) || value.pointer_version !== "3.0" || value.channel !== "rock-catalog-v3" ||
      typeof value.generation_id !== "string" || typeof value.root_manifest_url !== "string" ||
      typeof value.signature !== "string" || typeof value.key_id !== "string") {
    throw new Error("Catalog V3 pointer is invalid");
  }
}

function assertRoot(root: CatalogRootManifestV3, pointer: CatalogPointerV3): void {
  if (!isRecord(root) || root.manifest_version !== "3.0" || root.schema_version !== "3.0" ||
      root.generation_id !== pointer.generation_id || !Array.isArray(root.namespaces)) {
    throw new Error("Catalog root manifest is invalid or belongs to another generation");
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new Error("This browser cannot read gzip catalog buckets");
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const stream = new Blob([copy.buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function parseJson<T>(bytes: Uint8Array, label: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new Error(`Catalog JSON is malformed: ${label}`);
  }
}

function base64UrlBytes(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function grams(value: string): string[] {
  const compact = value.replaceAll(" ", "");
  const width = compact.length >= 3 ? 3 : 2;
  if (compact.length < width) return [compact];
  return [...new Set(Array.from({ length: compact.length - width + 1 }, (_, index) => compact.slice(index, index + width)))].sort();
}

function matchRank(kind: SearchResult["match_kind"]): number {
  return kind === "exact" ? 0 : kind === "prefix" ? 1 : 2;
}

function typeRank(type: SearchResult["entity_type"]): number {
  return type === "style" ? 0 : type === "artist" ? 1 : 2;
}
