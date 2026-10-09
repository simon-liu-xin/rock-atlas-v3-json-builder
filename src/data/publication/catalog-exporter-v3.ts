import { gzipSync, gunzipSync } from "node:zlib";

import {
  CATALOG_V3_CONTRACTS,
  canonicalJsonV1,
  type CatalogPointerV3,
} from "../contracts/catalog-v3.ts";
import {
  sha256Hex,
  signCatalogPointer,
  type CatalogPrivateKey,
} from "./catalog-signature.ts";

export interface CatalogSourceSnapshotV3 {
  readonly source: string;
  readonly snapshot_id: string;
  readonly license_partition: string;
}

export interface CatalogObjectEntryV3 {
  readonly url: string;
  readonly content_sha256: string;
  readonly object_sha256: string;
  readonly content_bytes: number;
  readonly object_bytes: number;
  readonly compression: "identity" | "gzip";
}

export interface CatalogNamespaceBucketV3 extends Omit<CatalogObjectEntryV3, "compression"> {
  readonly prefix: string;
  readonly record_count: number;
}

export interface CatalogNamespaceManifestV3 {
  readonly manifest_version: "3.0";
  readonly generation_id: string;
  readonly namespace: string;
  readonly prefix?: string;
  readonly buckets: readonly CatalogNamespaceBucketV3[];
  readonly shards?: readonly {
    readonly prefix: string;
    readonly manifest: CatalogObjectEntryV3;
  }[];
}

export interface CatalogRootManifestV3 {
  readonly manifest_version: "3.0";
  readonly generation_id: string;
  readonly schema_version: "3.0";
  readonly layout_version: "global-v1";
  readonly normalization: {
    readonly search: "search-normalization-v1";
    readonly identity: "identity-normalization-v1";
    readonly source_match: "source-match-normalization-v1";
  };
  readonly canonical_json_version: "canonical-json-v1";
  readonly generated_at: string;
  readonly sources: readonly CatalogSourceSnapshotV3[];
  readonly counts: {
    readonly canonical: Readonly<Record<string, number>>;
    readonly projections: Readonly<Record<string, number>>;
  };
  readonly overview: CatalogObjectEntryV3;
  readonly namespaces: readonly {
    readonly namespace: string;
    readonly manifest: CatalogObjectEntryV3;
  }[];
  readonly license_decision_ids: readonly string[];
  readonly gate_a: {
    readonly status: "not-run" | "pass" | "fail";
    readonly report_url: string | null;
    readonly report?: CatalogObjectEntryV3;
  };
}

export interface CatalogExportArtifact {
  readonly kind: "leaf" | "namespace-manifest" | "overview" | "root-manifest";
  readonly storage_key: string;
  readonly url: string;
  readonly bytes: Uint8Array;
  readonly content_sha256: string;
  readonly object_sha256: string;
  readonly compression: "identity" | "gzip";
}

export interface CatalogExportBundleV3 {
  readonly pointer: CatalogPointerV3;
  readonly pointer_bytes: Uint8Array;
  readonly root_manifest: CatalogRootManifestV3;
  readonly artifacts: readonly CatalogExportArtifact[];
  readonly report: {
    readonly object_count: number;
    readonly bucket_count: number;
    readonly total_object_bytes: number;
    readonly largest_leaf_object_bytes: number;
  };
}

export interface BuildCatalogExportV3Input {
  readonly generation_id: string;
  readonly generated_at: string;
  readonly published_at: string;
  readonly sources: readonly CatalogSourceSnapshotV3[];
  readonly counts: CatalogRootManifestV3["counts"];
  readonly overview: unknown;
  readonly namespaces: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly license_decision_ids: readonly string[];
  readonly gate_a: CatalogRootManifestV3["gate_a"];
  readonly leaf_hard_limit_bytes: number;
  readonly key_id: string;
  readonly private_key: CatalogPrivateKey;
}

const ROOT = "/data/rock-catalog-v3";

export function buildCatalogExportV3(input: BuildCatalogExportV3Input): CatalogExportBundleV3 {
  assertBuildInput(input);
  const generationSlug = input.generation_id.slice("mw:catalog-generation:".length);
  const artifacts: CatalogExportArtifact[] = [];
  const namespaceEntries: Array<{ namespace: string; manifest: CatalogObjectEntryV3 }> = [];

  for (const namespace of Object.keys(input.namespaces).sort()) {
    const buckets = buildNamespaceBuckets(
      namespace,
      input.namespaces[namespace] ?? {},
      input.leaf_hard_limit_bytes,
      artifacts,
    );
    const manifest: CatalogNamespaceManifestV3 = {
      manifest_version: "3.0",
      generation_id: input.generation_id,
      namespace,
      buckets,
    };
    const url = `${ROOT}/generations/${generationSlug}/manifests/${namespace}/root.json`;
    const artifact = identityArtifact("namespace-manifest", url, manifest);
    artifacts.push(artifact);
    namespaceEntries.push({ namespace, manifest: objectEntry(artifact) });
  }

  const overviewUrl = `${ROOT}/generations/${generationSlug}/overview.json`;
  const overviewArtifact = identityArtifact("overview", overviewUrl, input.overview);
  artifacts.push(overviewArtifact);

  const rootManifest: CatalogRootManifestV3 = {
    manifest_version: "3.0",
    generation_id: input.generation_id,
    schema_version: CATALOG_V3_CONTRACTS.schema,
    layout_version: CATALOG_V3_CONTRACTS.layout,
    normalization: {
      search: CATALOG_V3_CONTRACTS.search_normalization,
      identity: CATALOG_V3_CONTRACTS.identity_normalization,
      source_match: CATALOG_V3_CONTRACTS.source_match_normalization,
    },
    canonical_json_version: CATALOG_V3_CONTRACTS.canonical_json,
    generated_at: input.generated_at,
    sources: [...input.sources].sort((left, right) =>
      `${left.source}:${left.snapshot_id}`.localeCompare(`${right.source}:${right.snapshot_id}`, "en-US"),
    ),
    counts: input.counts,
    overview: objectEntry(overviewArtifact),
    namespaces: namespaceEntries,
    license_decision_ids: [...input.license_decision_ids].sort(),
    gate_a: input.gate_a,
  };
  const rootUrl = `${ROOT}/generations/${generationSlug}/root-manifest.json`;
  const rootArtifact = identityArtifact("root-manifest", rootUrl, rootManifest);
  artifacts.push(rootArtifact);

  const pointer = signCatalogPointer({
    pointer_version: "3.0",
    channel: "rock-catalog-v3",
    generation_id: input.generation_id,
    root_manifest_url: rootUrl,
    root_manifest_content_sha256: rootArtifact.content_sha256,
    root_manifest_object_sha256: rootArtifact.object_sha256,
    compatibility: {
      schema: { min: "3.0", max: "3.0" },
      layout: { min: "global-v1", max: "global-v1" },
      search_normalization: CATALOG_V3_CONTRACTS.search_normalization,
      identity_normalization: CATALOG_V3_CONTRACTS.identity_normalization,
      source_match_normalization: CATALOG_V3_CONTRACTS.source_match_normalization,
      canonical_json: CATALOG_V3_CONTRACTS.canonical_json,
    },
    published_at: input.published_at,
    key_id: input.key_id,
  }, input.private_key);
  const pointerBytes = Buffer.from(`${canonicalJsonV1(pointer)}\n`, "utf8");
  const leafArtifacts = artifacts.filter((artifact) => artifact.kind === "leaf");
  return {
    pointer,
    pointer_bytes: pointerBytes,
    root_manifest: rootManifest,
    artifacts,
    report: {
      object_count: artifacts.length,
      bucket_count: leafArtifacts.length,
      total_object_bytes: artifacts.reduce((total, artifact) => total + artifact.bytes.byteLength, 0),
      largest_leaf_object_bytes: Math.max(0, ...leafArtifacts.map((artifact) => artifact.bytes.byteLength)),
    },
  };
}

export function verifyCatalogExportBundle(bundle: CatalogExportBundleV3): void {
  const expectedPointerBytes = Buffer.from(`${canonicalJsonV1(bundle.pointer)}\n`, "utf8");
  if (!Buffer.from(bundle.pointer_bytes).equals(expectedPointerBytes)) {
    throw new Error("Catalog pointer bytes do not match the pointer document");
  }
  const artifacts = new Map(bundle.artifacts.map((artifact) => [artifact.url, artifact]));
  for (const artifact of bundle.artifacts) {
    if (sha256Hex(artifact.bytes) !== artifact.object_sha256) {
      throw new Error(`Catalog object SHA-256 mismatch for ${artifact.url}`);
    }
    const content = artifact.compression === "gzip" ? gunzipSync(artifact.bytes) : artifact.bytes;
    if (sha256Hex(content) !== artifact.content_sha256) {
      throw new Error(`Catalog content SHA-256 mismatch for ${artifact.url}`);
    }
  }
  const root = artifacts.get(bundle.pointer.root_manifest_url);
  if (!root || root.content_sha256 !== bundle.pointer.root_manifest_content_sha256 ||
      root.object_sha256 !== bundle.pointer.root_manifest_object_sha256) {
    throw new Error("Catalog root manifest does not match the signed pointer");
  }
  const expectedRootBytes = Buffer.from(`${canonicalJsonV1(bundle.root_manifest)}\n`, "utf8");
  if (!Buffer.from(root.bytes).equals(expectedRootBytes)) {
    throw new Error("Catalog root manifest bytes do not match the manifest document");
  }
  verifyEntry(bundle.root_manifest.overview, artifacts, "overview");
  for (const namespace of bundle.root_manifest.namespaces) {
    const manifestArtifact = verifyEntry(namespace.manifest, artifacts, namespace.namespace);
    const manifest = JSON.parse(Buffer.from(manifestArtifact.bytes).toString("utf8")) as CatalogNamespaceManifestV3;
    if (manifest.generation_id !== bundle.pointer.generation_id || manifest.namespace !== namespace.namespace) {
      throw new Error(`Catalog namespace manifest identity mismatch for ${namespace.namespace}`);
    }
    for (const bucket of manifest.buckets) verifyEntry({ ...bucket, compression: "gzip" }, artifacts, bucket.prefix);
  }
}

function buildNamespaceBuckets(
  namespace: string,
  records: Readonly<Record<string, unknown>>,
  limit: number,
  artifacts: CatalogExportArtifact[],
): CatalogNamespaceBucketV3[] {
  const rows = Object.entries(records)
    .map(([id, record]) => ({ id, record, hash: sha256Hex(Buffer.from(id.normalize("NFC"), "utf8")) }))
    .sort((left, right) => left.id.localeCompare(right.id, "en-US"));
  const buckets: CatalogNamespaceBucketV3[] = [];
  for (const prefix of "0123456789abcdef") {
    splitBucket(namespace, prefix, rows.filter((row) => row.hash.startsWith(prefix)), limit, artifacts, buckets);
  }
  return buckets.sort((left, right) => left.prefix.localeCompare(right.prefix, "en-US"));
}

function splitBucket(
  namespace: string,
  prefix: string,
  rows: readonly { id: string; record: unknown; hash: string }[],
  limit: number,
  artifacts: CatalogExportArtifact[],
  buckets: CatalogNamespaceBucketV3[],
): void {
  if (rows.length === 0) return;
  const payload = {
    bucket_version: "3.0",
    namespace,
    prefix,
    records: Object.fromEntries(rows.map((row) => [row.id, row.record])),
  };
  const content = Buffer.from(canonicalJsonV1(payload), "utf8");
  const compressed = gzipSync(content, { level: 9 });
  if (compressed.byteLength > limit) {
    if (rows.length === 1 || prefix.length >= 64) {
      throw new Error(`Catalog single record ${rows[0]?.id ?? "unknown"} exceeds leaf hard limit ${limit}`);
    }
    for (const nibble of "0123456789abcdef") {
      const next = `${prefix}${nibble}`;
      splitBucket(namespace, next, rows.filter((row) => row.hash.startsWith(next)), limit, artifacts, buckets);
    }
    return;
  }
  const objectSha = sha256Hex(compressed);
  const url = `${ROOT}/objects/sha256/${objectSha.slice(0, 2)}/${objectSha}.json.gz`;
  artifacts.push({
    kind: "leaf",
    storage_key: storageKey(url),
    url,
    bytes: compressed,
    content_sha256: sha256Hex(content),
    object_sha256: objectSha,
    compression: "gzip",
  });
  buckets.push({
    prefix,
    record_count: rows.length,
    url,
    content_sha256: sha256Hex(content),
    object_sha256: objectSha,
    content_bytes: content.byteLength,
    object_bytes: compressed.byteLength,
  });
}

function identityArtifact(
  kind: CatalogExportArtifact["kind"],
  url: string,
  value: unknown,
): CatalogExportArtifact {
  const bytes = Buffer.from(`${canonicalJsonV1(value)}\n`, "utf8");
  const hash = sha256Hex(bytes);
  return {
    kind,
    storage_key: storageKey(url),
    url,
    bytes,
    content_sha256: hash,
    object_sha256: hash,
    compression: "identity",
  };
}

function objectEntry(artifact: CatalogExportArtifact): CatalogObjectEntryV3 {
  return {
    url: artifact.url,
    content_sha256: artifact.content_sha256,
    object_sha256: artifact.object_sha256,
    content_bytes: artifact.compression === "identity"
      ? artifact.bytes.byteLength
      : gunzipSync(artifact.bytes).byteLength,
    object_bytes: artifact.bytes.byteLength,
    compression: artifact.compression,
  };
}

function verifyEntry(
  entry: CatalogObjectEntryV3,
  artifacts: ReadonlyMap<string, CatalogExportArtifact>,
  label: string,
): CatalogExportArtifact {
  const artifact = artifacts.get(entry.url);
  if (!artifact || artifact.content_sha256 !== entry.content_sha256 ||
      artifact.object_sha256 !== entry.object_sha256 || artifact.bytes.byteLength !== entry.object_bytes) {
    throw new Error(`Catalog manifest entry mismatch for ${label}`);
  }
  return artifact;
}

function storageKey(url: string): string {
  const prefix = `${ROOT}/`;
  if (!url.startsWith(prefix)) throw new Error(`Catalog URL is outside the V3 channel: ${url}`);
  return url.slice(prefix.length);
}

function assertBuildInput(input: BuildCatalogExportV3Input): void {
  if (!/^mw:catalog-generation:[a-z0-9][a-z0-9._-]*$/u.test(input.generation_id)) {
    throw new Error(`Invalid V3 generation id ${input.generation_id}`);
  }
  if (!Number.isInteger(input.leaf_hard_limit_bytes) || input.leaf_hard_limit_bytes < 1) {
    throw new Error("leaf_hard_limit_bytes must be a positive integer");
  }
  if (input.sources.length === 0) throw new Error("Catalog export requires at least one source snapshot");
  if (input.gate_a.status === "fail") throw new Error("Gate A failed; catalog export is blocked");
}
