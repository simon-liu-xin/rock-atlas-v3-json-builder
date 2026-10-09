import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  CATALOG_V3_CONTRACTS,
  canonicalJsonV1,
  type CatalogPointerV3,
} from "../contracts/catalog-v3.ts";
import type {
  CatalogNamespaceBucketV3,
  CatalogNamespaceManifestV3,
  CatalogObjectEntryV3,
  CatalogRootManifestV3,
  CatalogSourceSnapshotV3,
} from "./catalog-exporter-v3.ts";
import { FULL_FRONTEND_NAMESPACES } from "./catalog-full-projection-v3.ts";
import { FilesystemPublicationStore } from "./filesystem-publication-store.ts";
import {
  sha256Hex,
  signCatalogPointer,
  type CatalogPrivateKey,
} from "./catalog-signature.ts";

export interface CatalogJsonlNamespaceV3 {
  readonly namespace: string;
  readonly path: string;
  readonly record_count: number;
  readonly bytes: number;
  readonly sha256: string;
}

export interface PreparedCatalogProjectionV3 {
  readonly manifest_version: "3.0-prepared";
  readonly projection_scope: "full-frontend";
  readonly generation_id: string;
  readonly generated_at: string;
  readonly canonical_schema: string;
  readonly database: string;
  readonly sources: readonly CatalogSourceSnapshotV3[];
  readonly counts: CatalogRootManifestV3["counts"];
  readonly overview: {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  };
  readonly namespaces: readonly CatalogJsonlNamespaceV3[];
  readonly license_decision_ids: readonly string[];
  readonly gate_a: CatalogRootManifestV3["gate_a"];
}

export interface PublishCatalogJsonlV3Options {
  readonly projection_manifest_path: string;
  readonly static_root: string;
  readonly key_id: string;
  readonly private_key: CatalogPrivateKey;
  readonly published_at: string;
  readonly gate_a_report_path?: string;
  readonly leaf_hard_limit_bytes?: number;
  readonly namespace_manifest_hard_limit_bytes?: number;
  readonly publish_current: boolean;
}

export interface CatalogJsonlPublicationReportV3 {
  readonly report_version: "3.0";
  readonly generation_id: string;
  readonly current_pointer_updated: boolean;
  readonly namespace_count: number;
  readonly bucket_count: number;
  readonly record_count: number;
  readonly total_object_bytes: number;
  readonly largest_leaf_object_bytes: number;
  readonly pointer_sha256: string;
  readonly root_manifest_sha256: string;
}

interface SpoolRow {
  readonly hash: string;
  readonly id: string;
  readonly record: unknown;
}

const ROOT_URL = "/data/rock-catalog-v3";
const CURRENT_POINTER_KEY = "current.json";
const DEFAULT_LEAF_LIMIT = 512 * 1024;
const NAMESPACE_MANIFEST_HARD_LIMIT = 256 * 1024;
const ROOT_MANIFEST_HARD_LIMIT = 128 * 1024;
const OVERVIEW_HARD_LIMIT = 1024 * 1024;
const NIBBLES = "0123456789abcdef";

export async function publishCatalogJsonlV3(
  options: PublishCatalogJsonlV3Options,
): Promise<CatalogJsonlPublicationReportV3> {
  validatePublishOptions(options);
  const manifestPath = await validateRegularFile(options.projection_manifest_path, "projection manifest");
  const projectionRoot = dirname(manifestPath);
  const projection = parseProjectionManifest(await readFile(manifestPath, "utf8"));
  if (options.publish_current && projection.gate_a.status !== "pass") {
    throw new Error("Current pointer publication requires Gate A status pass");
  }

  const overviewPath = await resolveProjectionFile(
    projectionRoot,
    projection.overview.path,
    projection.overview.bytes,
    projection.overview.sha256,
    "overview",
  );
  const namespaceSources = [];
  for (const entry of projection.namespaces) {
    namespaceSources.push({
      entry,
      path: await resolveProjectionFile(
      projectionRoot,
      entry.path,
      entry.bytes,
      entry.sha256,
      `namespace ${entry.namespace}`,
      ),
    });
  }

  const staticRoot = await validatePublicationRoot(options.static_root);
  const store = new FilesystemPublicationStore(staticRoot);
  const generationSlug = projection.generation_id.slice("mw:catalog-generation:".length);
  const temporaryRoot = await mkdtemp(join(dirname(staticRoot), ".catalog-v3-spool-"));
  let bucketCount = 0;
  let recordCount = 0;
  let totalObjectBytes = 0;
  let largestLeafObjectBytes = 0;
  const rootNamespaces: Array<{ namespace: string; manifest: CatalogObjectEntryV3 }> = [];

  try {
    let gateAReport: CatalogObjectEntryV3 | undefined;
    if (projection.gate_a.status === "pass") {
      const report = await readGateAReport(
        options.gate_a_report_path,
        projection.gate_a.report_url,
        generationSlug,
      );
      await putAndVerify(store, storageKey(report.url), report.bytes);
      gateAReport = identityEntry(report.url, report.bytes);
      totalObjectBytes += report.bytes.byteLength;
    }
    for (const source of [...namespaceSources].sort((left, right) =>
      left.entry.namespace.localeCompare(right.entry.namespace, "en-US")
    )) {
      const namespaceSpool = join(temporaryRoot, source.entry.namespace);
      const initial = await partitionJsonlNamespace(source.path, namespaceSpool, source.entry);
      const buckets: CatalogNamespaceBucketV3[] = [];
      for (const prefix of NIBBLES) {
        const item = initial.get(prefix);
        if (!item || item.count === 0) continue;
        await processSpoolBucket({
          namespace: source.entry.namespace,
          prefix,
          path: item.path,
          count: item.count,
          limit: options.leaf_hard_limit_bytes ?? DEFAULT_LEAF_LIMIT,
          spoolRoot: namespaceSpool,
          store,
          buckets,
        });
      }
      const sortedBuckets = buckets.sort((left, right) => left.prefix.localeCompare(right.prefix, "en-US"));
      const namespaceBaseUrl = `${ROOT_URL}/generations/${generationSlug}/manifests/${source.entry.namespace}`;
      const namespacePublication = await publishNamespaceManifest({
        store,
        generationId: projection.generation_id,
        namespace: source.entry.namespace,
        baseUrl: namespaceBaseUrl,
        prefix: "",
        buckets: sortedBuckets,
        hardLimit: options.namespace_manifest_hard_limit_bytes ?? NAMESPACE_MANIFEST_HARD_LIMIT,
      });
      rootNamespaces.push({
        namespace: source.entry.namespace,
        manifest: namespacePublication.entry,
      });
      bucketCount += sortedBuckets.length;
      recordCount += source.entry.record_count;
      totalObjectBytes += namespacePublication.totalBytes + sortedBuckets.reduce(
        (total, bucket) => total + bucket.object_bytes,
        0,
      );
      largestLeafObjectBytes = Math.max(
        largestLeafObjectBytes,
        ...sortedBuckets.map((bucket) => bucket.object_bytes),
      );
    }

    const overviewValue = JSON.parse(await readFile(overviewPath, "utf8"));
    const overviewBytes = canonicalBytes(overviewValue);
    if (overviewBytes.byteLength > OVERVIEW_HARD_LIMIT) {
      throw new Error(`Catalog overview exceeds ${OVERVIEW_HARD_LIMIT} bytes`);
    }
    const overviewUrl = `${ROOT_URL}/generations/${generationSlug}/overview.json`;
    await putAndVerify(store, storageKey(overviewUrl), overviewBytes);
    totalObjectBytes += overviewBytes.byteLength;

    const rootManifest: CatalogRootManifestV3 = {
      manifest_version: "3.0",
      generation_id: projection.generation_id,
      schema_version: CATALOG_V3_CONTRACTS.schema,
      layout_version: CATALOG_V3_CONTRACTS.layout,
      normalization: {
        search: CATALOG_V3_CONTRACTS.search_normalization,
        identity: CATALOG_V3_CONTRACTS.identity_normalization,
        source_match: CATALOG_V3_CONTRACTS.source_match_normalization,
      },
      canonical_json_version: CATALOG_V3_CONTRACTS.canonical_json,
      generated_at: projection.generated_at,
      sources: [...projection.sources].sort((left, right) =>
        `${left.source}:${left.snapshot_id}`.localeCompare(`${right.source}:${right.snapshot_id}`, "en-US")
      ),
      counts: projection.counts,
      overview: identityEntry(overviewUrl, overviewBytes),
      namespaces: rootNamespaces,
      license_decision_ids: [...projection.license_decision_ids].sort(),
      gate_a: {
        status: projection.gate_a.status,
        report_url: projection.gate_a.report_url,
        ...(gateAReport ? { report: gateAReport } : {}),
      },
    };
    const rootUrl = `${ROOT_URL}/generations/${generationSlug}/root-manifest.json`;
    const rootBytes = canonicalBytes(rootManifest);
    if (rootBytes.byteLength > ROOT_MANIFEST_HARD_LIMIT) {
      throw new Error(`Catalog root manifest exceeds ${ROOT_MANIFEST_HARD_LIMIT} bytes`);
    }
    await putAndVerify(store, storageKey(rootUrl), rootBytes);
    totalObjectBytes += rootBytes.byteLength;
    await verifyPublishedTree(store, rootManifest);

    const pointer: CatalogPointerV3 = signCatalogPointer({
      pointer_version: "3.0",
      channel: "rock-catalog-v3",
      generation_id: projection.generation_id,
      root_manifest_url: rootUrl,
      root_manifest_content_sha256: sha256Hex(rootBytes),
      root_manifest_object_sha256: sha256Hex(rootBytes),
      compatibility: {
        schema: { min: "3.0", max: "3.0" },
        layout: { min: "global-v1", max: "global-v1" },
        search_normalization: CATALOG_V3_CONTRACTS.search_normalization,
        identity_normalization: CATALOG_V3_CONTRACTS.identity_normalization,
        source_match_normalization: CATALOG_V3_CONTRACTS.source_match_normalization,
        canonical_json: CATALOG_V3_CONTRACTS.canonical_json,
      },
      published_at: options.published_at,
      key_id: options.key_id,
    }, options.private_key);
    const pointerBytes = canonicalBytes(pointer);
    const candidatePointerKey = `generations/${generationSlug}/candidate-current.json`;
    await putAndVerify(store, candidatePointerKey, pointerBytes);

    if (options.publish_current) {
      await store.withPointerLock(CURRENT_POINTER_KEY, async () => {
        await verifyPublishedTree(store, rootManifest);
        await store.replacePointerAtomically(CURRENT_POINTER_KEY, pointerBytes);
      });
    }

    const report: CatalogJsonlPublicationReportV3 = {
      report_version: "3.0",
      generation_id: projection.generation_id,
      current_pointer_updated: options.publish_current,
      namespace_count: rootNamespaces.length,
      bucket_count: bucketCount,
      record_count: recordCount,
      total_object_bytes: totalObjectBytes,
      largest_leaf_object_bytes: largestLeafObjectBytes,
      pointer_sha256: sha256Hex(pointerBytes),
      root_manifest_sha256: sha256Hex(rootBytes),
    };
    await putAndVerify(
      store,
      `generations/${generationSlug}/publication-report.json`,
      canonicalBytes(report),
    );
    return report;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function partitionJsonlNamespace(
  inputPath: string,
  spoolRoot: string,
  expected: CatalogJsonlNamespaceV3,
): Promise<Map<string, { path: string; count: number }>> {
  const streams = await createPartitionStreams(spoolRoot, "");
  const counts = new Map<string, number>();
  let previousId = "";
  let count = 0;
  try {
    for await (const value of readJsonLines(inputPath)) {
      const row = validateNamespaceRow(value, expected.namespace);
      if (previousId && row.id.localeCompare(previousId, "en-US") <= 0) {
        throw new Error(`Namespace ${expected.namespace} records are not strictly sorted by id`);
      }
      previousId = row.id;
      const hash = sha256Text(row.id.normalize("NFC"));
      const prefix = hash[0]!;
      await writeStreamLine(streams.get(prefix)!, `${canonicalJsonV1({ hash, id: row.id, record: row.record })}\n`);
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
      count += 1;
    }
  } finally {
    await closeStreams(streams.values());
  }
  if (count !== expected.record_count) {
    throw new Error(`Namespace ${expected.namespace} record count ${count} does not match ${expected.record_count}`);
  }
  return new Map([...streams].map(([prefix, stream]) => [prefix, {
    path: String(stream.path),
    count: counts.get(prefix) ?? 0,
  }]));
}

async function processSpoolBucket(input: {
  namespace: string;
  prefix: string;
  path: string;
  count: number;
  limit: number;
  spoolRoot: string;
  store: FilesystemPublicationStore;
  buckets: CatalogNamespaceBucketV3[];
}): Promise<void> {
  const file = await stat(input.path);
  const memoryLimit = input.limit * 12;
  if (file.size > memoryLimit) {
    await splitAndRecurse(input);
    return;
  }
  const records: Record<string, unknown> = {};
  for await (const value of readJsonLines(input.path)) {
    const row = validateSpoolRow(value, input.prefix);
    records[row.id] = row.record;
  }
  const content = Buffer.from(canonicalJsonV1({
    bucket_version: "3.0",
    namespace: input.namespace,
    prefix: input.prefix,
    records,
  }), "utf8");
  const compressed = gzipSync(content, { level: 9 });
  if (compressed.byteLength > input.limit) {
    if (input.count === 1 || input.prefix.length >= 64) {
      throw new Error(`Catalog single record in ${input.namespace}:${input.prefix} exceeds ${input.limit} bytes`);
    }
    await splitAndRecurse(input);
    return;
  }
  const objectSha = sha256Hex(compressed);
  const url = `${ROOT_URL}/objects/sha256/${objectSha.slice(0, 2)}/${objectSha}.json.gz`;
  await putAndVerify(input.store, storageKey(url), compressed);
  input.buckets.push({
    prefix: input.prefix,
    record_count: input.count,
    url,
    content_sha256: sha256Hex(content),
    object_sha256: objectSha,
    content_bytes: content.byteLength,
    object_bytes: compressed.byteLength,
  });
  await rm(input.path, { force: true });
}

async function splitAndRecurse(input: Parameters<typeof processSpoolBucket>[0]): Promise<void> {
  if (input.prefix.length >= 64) {
    throw new Error(`Catalog bucket ${input.namespace}:${input.prefix} cannot be split further`);
  }
  const streams = await createPartitionStreams(input.spoolRoot, input.prefix);
  const counts = new Map<string, number>();
  try {
    for await (const value of readJsonLines(input.path)) {
      const row = validateSpoolRow(value, input.prefix);
      const nextPrefix = row.hash.slice(0, input.prefix.length + 1);
      await writeStreamLine(streams.get(nextPrefix)!, `${canonicalJsonV1(row)}\n`);
      counts.set(nextPrefix, (counts.get(nextPrefix) ?? 0) + 1);
    }
  } finally {
    await closeStreams(streams.values());
  }
  await rm(input.path, { force: true });
  if (input.count === 1) {
    throw new Error(`Catalog single record in ${input.namespace}:${input.prefix} exceeds ${input.limit} bytes`);
  }
  for (const [prefix, stream] of streams) {
    const count = counts.get(prefix) ?? 0;
    if (count === 0) {
      await rm(String(stream.path), { force: true });
      continue;
    }
    await processSpoolBucket({ ...input, prefix, path: String(stream.path), count });
  }
}

async function createPartitionStreams(root: string, prefix: string): Promise<Map<string, WriteStream>> {
  await mkdir(root, { recursive: true });
  const streams = new Map<string, WriteStream>();
  for (const nibble of NIBBLES) {
    const next = `${prefix}${nibble}`;
    streams.set(next, createWriteStream(join(root, `${next}.jsonl`), { flags: "wx", mode: 0o600 }));
  }
  return streams;
}

async function writeStreamLine(stream: WriteStream, value: string): Promise<void> {
  if (stream.write(value)) return;
  await new Promise<void>((resolveDrain, rejectDrain) => {
    stream.once("drain", resolveDrain);
    stream.once("error", rejectDrain);
  });
}

async function closeStreams(streams: Iterable<WriteStream>): Promise<void> {
  await Promise.all([...streams].map((stream) => new Promise<void>((resolveEnd, rejectEnd) => {
    stream.once("error", rejectEnd);
    stream.end(resolveEnd);
  })));
}

async function* readJsonLines(path: string): AsyncIterable<unknown> {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        throw new Error(`Malformed JSONL record in ${path}`);
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

function validateNamespaceRow(value: unknown, namespace: string): { id: string; record: unknown } {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id || !("record" in value)) {
    throw new Error(`Namespace ${namespace} contains an invalid JSONL row`);
  }
  return { id: value.id, record: value.record };
}

function validateSpoolRow(value: unknown, prefix: string): SpoolRow {
  if (!isRecord(value) || typeof value.hash !== "string" || !value.hash.startsWith(prefix) ||
      typeof value.id !== "string" || !("record" in value)) {
    throw new Error(`Catalog spool row does not match prefix ${prefix}`);
  }
  return { hash: value.hash, id: value.id, record: value.record };
}

async function resolveProjectionFile(
  root: string,
  relativePath: string,
  expectedBytes: number,
  expectedSha256: string,
  label: string,
): Promise<string> {
  if (!relativePath || isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new Error(`${label} path must be relative`);
  }
  const path = resolve(root, relativePath);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(`${label} path escapes projection root`);
  const validated = await validateRegularFile(path, label);
  if (validated !== root && !validated.startsWith(`${root}${sep}`)) {
    throw new Error(`${label} resolves outside projection root`);
  }
  const info = await stat(validated);
  if (info.size !== expectedBytes || await sha256File(validated) !== expectedSha256) {
    throw new Error(`${label} bytes or SHA-256 do not match the projection manifest`);
  }
  return validated;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function validateRegularFile(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return realpath(path);
}

async function validatePublicationRoot(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("static root path must be absolute");
  const requested = resolve(path);
  const existing = await lstat(requested).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error("static root must be a regular directory or a new path");
    }
    return realpath(requested);
  }
  const parent = await realpath(dirname(requested));
  return join(parent, basename(requested));
}

async function readGateAReport(
  path: string | undefined,
  reportUrl: string | null,
  generationSlug: string,
): Promise<{ url: string; bytes: Buffer }> {
  if (!path) throw new Error("Gate A pass requires a local gate_a_report_path");
  const expectedUrl = `${ROOT_URL}/generations/${generationSlug}/gate-a-report.json`;
  if (reportUrl !== expectedUrl) {
    throw new Error(`Gate A report URL must equal ${expectedUrl}`);
  }
  const resolved = await validateRegularFile(path, "Gate A report");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolved, "utf8"));
  } catch {
    throw new Error("Gate A report contains malformed JSON");
  }
  if (!isRecord(value) || value.report_version !== "3.0" || value.gate !== "A" ||
      value.status !== "pass" || !isRecord(value.readiness) ||
      value.readiness.v3_architecture_ready !== true ||
      !Array.isArray(value.blockers) || value.blockers.length !== 0) {
    throw new Error("Gate A report is not a valid passing report");
  }
  return { url: reportUrl, bytes: canonicalBytes(value) };
}

function parseProjectionManifest(text: string): PreparedCatalogProjectionV3 {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Prepared projection manifest is malformed JSON");
  }
  if (!isRecord(value) || value.manifest_version !== "3.0-prepared" ||
      value.projection_scope !== "full-frontend" ||
      typeof value.generation_id !== "string" || !/^mw:catalog-generation:[a-z0-9][a-z0-9._-]*$/u.test(value.generation_id) ||
      typeof value.generated_at !== "string" || !Number.isFinite(Date.parse(value.generated_at)) ||
      typeof value.canonical_schema !== "string" || typeof value.database !== "string" ||
      !Array.isArray(value.sources) || value.sources.length === 0 ||
      !isRecord(value.counts) || !isRecord(value.overview) || !Array.isArray(value.namespaces) ||
      !Array.isArray(value.license_decision_ids) || !isRecord(value.gate_a)) {
    throw new Error("Prepared projection manifest contract mismatch");
  }
  const gateA = value.gate_a;
  if (!isRecord(gateA) || !["not-run", "pass", "fail"].includes(String(gateA.status)) ||
      (gateA.report_url !== null && typeof gateA.report_url !== "string") ||
      (gateA.status === "pass" && typeof gateA.report_url !== "string") ||
      (gateA.status === "not-run" && gateA.report_url !== null)) {
    throw new Error("Prepared projection Gate A contract mismatch");
  }
  if (!validCountMap((value.counts as Record<string, unknown>).canonical) ||
      !validCountMap((value.counts as Record<string, unknown>).projections)) {
    throw new Error("Prepared projection counts contract mismatch");
  }
  const sources = value.sources as unknown[];
  if (sources.some((source) => !isRecord(source) || typeof source.source !== "string" ||
      !source.source || typeof source.snapshot_id !== "string" || !source.snapshot_id ||
      typeof source.license_partition !== "string" || !source.license_partition)) {
    throw new Error("Prepared projection source contract mismatch");
  }
  const licenseIds = value.license_decision_ids as unknown[];
  if (licenseIds.length === 0 || licenseIds.some((id) => typeof id !== "string" || !id) ||
      new Set(licenseIds).size !== licenseIds.length) {
    throw new Error("Prepared projection license decision contract mismatch");
  }
  const namespaces = value.namespaces as unknown[];
  const names = new Set<string>();
  for (const entry of namespaces) {
    if (!isRecord(entry) || typeof entry.namespace !== "string" ||
        !/^[a-z][a-z0-9-]*$/u.test(entry.namespace) || names.has(entry.namespace) ||
        typeof entry.path !== "string" || !isNonNegativeInteger(entry.record_count) ||
        !isNonNegativeInteger(entry.bytes) || !isSha256(entry.sha256)) {
      throw new Error("Prepared projection namespace contract mismatch");
    }
    names.add(entry.namespace);
  }
  const requiredNamespaces = new Set<string>(FULL_FRONTEND_NAMESPACES);
  if (names.size !== requiredNamespaces.size || [...requiredNamespaces].some((name) => !names.has(name))) {
    throw new Error("Prepared projection must contain every full frontend namespace");
  }
  const overview = value.overview;
  if (typeof overview.path !== "string" || !isNonNegativeInteger(overview.bytes) || !isSha256(overview.sha256)) {
    throw new Error("Prepared projection overview contract mismatch");
  }
  return value as unknown as PreparedCatalogProjectionV3;
}

function validatePublishOptions(options: PublishCatalogJsonlV3Options): void {
  if (!isAbsolute(options.projection_manifest_path) || !isAbsolute(options.static_root)) {
    throw new Error("Projection manifest and static root paths must be absolute");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(options.key_id)) throw new Error("Invalid catalog key id");
  if (!Number.isFinite(Date.parse(options.published_at))) throw new Error("published_at must be an ISO timestamp");
  if (options.leaf_hard_limit_bytes !== undefined &&
      (!Number.isInteger(options.leaf_hard_limit_bytes) || options.leaf_hard_limit_bytes < 256)) {
    throw new Error("leaf_hard_limit_bytes must be an integer of at least 256 bytes");
  }
  if (options.namespace_manifest_hard_limit_bytes !== undefined &&
      (!Number.isInteger(options.namespace_manifest_hard_limit_bytes) ||
       options.namespace_manifest_hard_limit_bytes < 8 * 1024)) {
    throw new Error("namespace_manifest_hard_limit_bytes must be an integer of at least 8192 bytes");
  }
}

async function putAndVerify(store: FilesystemPublicationStore, key: string, bytes: Uint8Array): Promise<void> {
  await store.putImmutable(key, bytes);
  const stored = await store.read(key);
  if (!Buffer.from(stored).equals(Buffer.from(bytes))) throw new Error(`Publication readback mismatch for ${key}`);
}

async function verifyPublishedTree(store: FilesystemPublicationStore, root: CatalogRootManifestV3): Promise<void> {
  await verifyStoredEntry(store, root.overview);
  if (root.gate_a.report) await verifyStoredEntry(store, root.gate_a.report);
  for (const namespace of root.namespaces) {
    await verifyNamespaceTree(store, namespace.namespace, namespace.manifest, root.generation_id);
  }
}

async function verifyNamespaceTree(
  store: FilesystemPublicationStore,
  namespace: string,
  entry: CatalogObjectEntryV3,
  generationId: string,
): Promise<void> {
  const bytes = await verifyStoredEntry(store, entry);
  const manifest = JSON.parse(Buffer.from(bytes).toString("utf8")) as CatalogNamespaceManifestV3;
  if (manifest.namespace !== namespace || manifest.generation_id !== generationId) {
    throw new Error(`Publication namespace tree identity mismatch for ${namespace}`);
  }
  for (const bucket of manifest.buckets) {
    await verifyStoredEntry(store, { ...bucket, compression: "gzip" });
  }
  for (const shard of manifest.shards ?? []) {
    await verifyNamespaceTree(store, namespace, shard.manifest, generationId);
  }
}

async function verifyStoredEntry(
  store: FilesystemPublicationStore,
  entry: CatalogObjectEntryV3,
): Promise<Uint8Array> {
  const bytes = await store.read(storageKey(entry.url));
  if (bytes.byteLength !== entry.object_bytes || sha256Hex(bytes) !== entry.object_sha256) {
    throw new Error(`Publication object verification failed for ${entry.url}`);
  }
  let content: Uint8Array;
  try {
    content = entry.compression === "gzip" ? gunzipSync(bytes) : bytes;
  } catch {
    throw new Error(`Publication content decompression failed for ${entry.url}`);
  }
  if (content.byteLength !== entry.content_bytes || sha256Hex(content) !== entry.content_sha256) {
    throw new Error(`Publication content verification failed for ${entry.url}`);
  }
  return bytes;
}

async function publishNamespaceManifest(input: {
  store: FilesystemPublicationStore;
  generationId: string;
  namespace: string;
  baseUrl: string;
  prefix: string;
  buckets: readonly CatalogNamespaceBucketV3[];
  hardLimit: number;
}): Promise<{ entry: CatalogObjectEntryV3; totalBytes: number }> {
  const directManifest: CatalogNamespaceManifestV3 = {
    manifest_version: "3.0",
    generation_id: input.generationId,
    namespace: input.namespace,
    ...(input.prefix ? { prefix: input.prefix } : {}),
    buckets: input.buckets,
  };
  const directBytes = canonicalBytes(directManifest);
  if (directBytes.byteLength <= input.hardLimit) {
    const url = input.prefix
      ? `${input.baseUrl}/shards/${input.prefix}.json`
      : `${input.baseUrl}/root.json`;
    await putAndVerify(input.store, storageKey(url), directBytes);
    return { entry: identityEntry(url, directBytes), totalBytes: directBytes.byteLength };
  }
  if (input.prefix.length >= 64) {
    throw new Error(`Namespace manifest ${input.namespace}:${input.prefix} cannot be split further`);
  }
  const shards: Array<{ prefix: string; manifest: CatalogObjectEntryV3 }> = [];
  let totalBytes = 0;
  for (const nibble of NIBBLES) {
    const prefix = `${input.prefix}${nibble}`;
    const buckets = input.buckets.filter((bucket) => bucket.prefix.startsWith(prefix));
    if (buckets.length === 0) continue;
    const child = await publishNamespaceManifest({ ...input, prefix, buckets });
    shards.push({ prefix, manifest: child.entry });
    totalBytes += child.totalBytes;
  }
  const routedManifest: CatalogNamespaceManifestV3 = {
    manifest_version: "3.0",
    generation_id: input.generationId,
    namespace: input.namespace,
    ...(input.prefix ? { prefix: input.prefix } : {}),
    buckets: [],
    shards,
  };
  const routedBytes = canonicalBytes(routedManifest);
  if (routedBytes.byteLength > input.hardLimit) {
    throw new Error(`Routed namespace manifest ${input.namespace}:${input.prefix} exceeds ${input.hardLimit} bytes`);
  }
  const url = input.prefix
    ? `${input.baseUrl}/shards/${input.prefix}.json`
    : `${input.baseUrl}/root.json`;
  await putAndVerify(input.store, storageKey(url), routedBytes);
  return {
    entry: identityEntry(url, routedBytes),
    totalBytes: totalBytes + routedBytes.byteLength,
  };
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalJsonV1(value)}\n`, "utf8");
}

function identityEntry(url: string, bytes: Uint8Array): CatalogObjectEntryV3 {
  const hash = sha256Hex(bytes);
  return {
    url,
    content_sha256: hash,
    object_sha256: hash,
    content_bytes: bytes.byteLength,
    object_bytes: bytes.byteLength,
    compression: "identity",
  };
}

function storageKey(url: string): string {
  const prefix = `${ROOT_URL}/`;
  if (!url.startsWith(prefix)) throw new Error(`Catalog URL is outside ${ROOT_URL}: ${url}`);
  return url.slice(prefix.length);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validCountMap(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(isNonNegativeInteger);
}
