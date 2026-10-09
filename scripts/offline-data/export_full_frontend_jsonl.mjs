import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { canonicalJsonV1 } from "../../src/data/contracts/catalog-v3.ts";
import { parseLegacyCatalogIdentityInput } from "../../src/data/catalog/legacy-catalog-identity.ts";
import {
  FULL_FRONTEND_NAMESPACES,
  FULL_OVERVIEW_RELATION_LIMIT,
  buildFullCatalogOverview,
  fullCatalogCountsSql,
  fullCatalogLegacyResolutionSql,
  fullCatalogNamespaceSql,
  fullCatalogSourcesSql,
  relationOverviewRank,
} from "../../src/data/publication/catalog-full-projection-v3.ts";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

await main().catch((error) => {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const canonicalManifestPath = await validateRegularFile(options.canonicalManifest, "canonical manifest");
  const canonicalManifest = parseCanonicalManifest(await readFile(canonicalManifestPath, "utf8"));
  const generationId = toV3GenerationId(canonicalManifest.generation_id);
  validateGateAOptions(options, generationId);
  const legacyCatalog = await readLegacyCatalog(options.legacyCatalog);
  const outputDir = await validateNewOutputDirectory(options.outputDir);
  const psqlCommand = await validatePsqlCommand(options.psqlCommand);
  const generatedAt = validateTimestamp(options.generatedAt ?? new Date().toISOString(), "generated-at");
  const temporaryDir = await mkdtemp(join(dirname(outputDir), ".frontend-projection-v3-"));
  let published = false;

  try {
    const namespaces = [];
    for (const namespace of FULL_FRONTEND_NAMESPACES) {
      const path = join(temporaryDir, `${namespace}.jsonl`);
      const evidence = namespace === "identity-resolution"
        ? await exportLegacyIdentityResolution({
            psqlCommand,
            database: canonicalManifest.database,
            schema: canonicalManifest.canonical_schema,
            path,
            legacyCatalog,
          })
        : await exportNamespace({
            psqlCommand,
            database: canonicalManifest.database,
            namespace,
            sql: fullCatalogNamespaceSql(namespace, canonicalManifest.canonical_schema),
            path,
          });
      namespaces.push({ namespace, path: `${namespace}.jsonl`, ...evidence });
    }

    const styles = await readSmallNamespace(join(temporaryDir, "style-summary.jsonl"), 5_000);
    const relations = await readOverviewRelations(
      join(temporaryDir, "relation.jsonl"),
      FULL_OVERVIEW_RELATION_LIMIT,
    );
    const overview = buildFullCatalogOverview(styles, relations, generationId);
    const overviewBytes = Buffer.from(`${canonicalJsonV1(overview)}\n`, "utf8");
    const overviewPath = join(temporaryDir, "overview.json");
    await writeExclusive(overviewPath, overviewBytes);

    const counts = await queryJson(
      psqlCommand,
      canonicalManifest.database,
      "counts",
      fullCatalogCountsSql(canonicalManifest.canonical_schema),
    );
    validateCanonicalCounts(canonicalManifest, counts);
    counts.projections = {
      ...counts.projections,
      identity_resolution_records: namespaces.find(
        (entry) => entry.namespace === "identity-resolution"
      )?.record_count ?? 0,
      style_relation_page_records: namespaces.find(
        (entry) => entry.namespace === "style-relations"
      )?.record_count ?? 0,
    };
    const sources = await queryJson(
      psqlCommand,
      canonicalManifest.database,
      "sources",
      fullCatalogSourcesSql(canonicalManifest.canonical_schema),
    );
    if (!Array.isArray(sources) || sources.length === 0) {
      throw new Error("Canonical schema has no validated or published source snapshots");
    }
    const projectionManifest = {
      manifest_version: "3.0-prepared",
      projection_scope: "full-frontend",
      generation_id: generationId,
      generated_at: generatedAt,
      canonical_schema: canonicalManifest.canonical_schema,
      database: canonicalManifest.database,
      sources,
      counts,
      overview: {
        path: "overview.json",
        bytes: overviewBytes.byteLength,
        sha256: sha256(overviewBytes),
      },
      namespaces,
      license_decision_ids: [...new Set(sources.map((source) =>
        `mw:license-decision:${slug(source.license_partition)}`
      ))].sort(),
      gate_a: {
        status: options.gateAStatus,
        report_url: options.gateAReportUrl,
      },
      legacy_identity_resolution: legacyCatalog.evidence,
    };
    await writeExclusive(
      join(temporaryDir, "projection-manifest.json"),
      Buffer.from(`${canonicalJsonV1(projectionManifest)}\n`, "utf8"),
    );
    await rename(temporaryDir, outputDir);
    published = true;
    process.stdout.write(`${JSON.stringify({
      mode: "full-frontend-jsonl-projection",
      generation_id: generationId,
      canonical_schema: canonicalManifest.canonical_schema,
      output_dir: outputDir,
      namespace_count: namespaces.length,
      record_count: namespaces.reduce((total, entry) => total + entry.record_count, 0),
      counts,
    }, null, 2)}\n`);
  } finally {
    if (!published) await rm(temporaryDir, { recursive: true, force: true });
  }
}

async function exportNamespace({ psqlCommand, database, namespace, sql, path }) {
  const child = spawn(psqlCommand, [
    "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-d", database,
    "-c", `/* musicwiki-export:${namespace} */ ${sql.trim()}`,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const handle = await open(path, "wx", 0o600);
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", resolveExit);
  });
  const hash = createHash("sha256");
  let bytes = 0;
  let recordCount = 0;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 128 * 1024) stderr += chunk;
  });
  try {
    for await (const chunk of child.stdout) {
      const buffer = Buffer.from(chunk);
      await writeAll(handle, buffer);
      hash.update(buffer);
      bytes += buffer.byteLength;
      for (const byte of buffer) if (byte === 10) recordCount += 1;
    }
    const code = await exit;
    if (code !== 0) throw new Error(`psql export ${namespace} failed (${code}): ${stderr.trim()}`);
    await handle.sync();
  } catch (error) {
    child.kill("SIGTERM");
    await exit.catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
  return { record_count: recordCount, bytes, sha256: hash.digest("hex") };
}

async function exportLegacyIdentityResolution({ psqlCommand, database, schema, path, legacyCatalog }) {
  const mappings = await queryJson(
    psqlCommand,
    database,
    "identity-targets",
    fullCatalogLegacyResolutionSql(schema, legacyCatalog.candidates),
  );
  const requested = new Set(legacyCatalog.candidates.map((candidate) => candidate.from_id));
  const mapped = new Set();
  if (!Array.isArray(mappings) || mappings.some((mapping) => {
    const invalid = !mapping || typeof mapping.from_id !== "string" ||
      typeof mapping.entity_id !== "string" || !requested.has(mapping.from_id) ||
      !/^mw:(?:style|artist|release-group):[a-z0-9][a-z0-9._:-]*$/u.test(mapping.entity_id) ||
      mapped.has(mapping.from_id);
    if (!invalid) mapped.add(mapping.from_id);
    return invalid;
  })) throw new Error("Canonical legacy identity query returned invalid mappings");
  const resolved = new Map(mappings.map((mapping) => [mapping.from_id, mapping.entity_id]));
  const rows = [
    ...legacyCatalog.candidates.map((candidate) => ({
      id: candidate.from_id,
      record: resolved.get(candidate.from_id) === candidate.from_id
        ? { status: "current", entity_id: candidate.from_id }
        : resolved.has(candidate.from_id)
          ? { status: "redirected", from_id: candidate.from_id, entity_id: resolved.get(candidate.from_id) }
        : { status: "removed", entity_id: candidate.from_id, reason: "not-resolved-in-full-rock-catalog" },
    })),
    ...legacyCatalog.unresolved_ids.map((id) => ({
      id,
      record: { status: "removed", entity_id: id, reason: "legacy-identity-has-no-stable-external-id" },
    })),
  ].sort((left, right) => left.id.localeCompare(right.id, "en-US"));
  const bytes = Buffer.from(rows.map((row) => `${canonicalJsonV1(row)}\n`).join(""));
  await writeExclusive(path, bytes);
  legacyCatalog.evidence.current = rows.filter((row) => row.record.status === "current").length;
  legacyCatalog.evidence.redirected = rows.filter((row) => row.record.status === "redirected").length;
  legacyCatalog.evidence.removed = rows.filter((row) => row.record.status === "removed").length;
  return { record_count: rows.length, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

async function readLegacyCatalog(path) {
  const resolved = await validateRegularFile(path, "legacy catalog");
  const bytes = await readFile(resolved);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch {
    throw new Error("Legacy catalog contains malformed JSON");
  }
  const parsed = parseLegacyCatalogIdentityInput(value);
  return {
    ...parsed,
    evidence: {
      generation_id: parsed.generation_id,
      catalog_bytes: bytes.byteLength,
      catalog_sha256: sha256(bytes),
      identity_count: parsed.candidates.length + parsed.unresolved_ids.length,
      current: 0,
      redirected: 0,
      removed: 0,
    },
  };
}

async function queryJson(command, database, label, sql) {
  const result = await execFileAsync(command, [
    "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-d", database,
    "-c", `/* musicwiki-export:${label} */ ${sql}`,
  ], { maxBuffer: 8 * 1024 * 1024 });
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(`psql ${label} query returned malformed JSON`);
  }
}

async function readSmallNamespace(path, hardLimit) {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const records = [];
  try {
    for await (const line of lines) {
      if (!line) continue;
      const value = JSON.parse(line);
      if (!value || typeof value !== "object" || !("record" in value)) {
        throw new Error(`Overview namespace row is invalid: ${path}`);
      }
      records.push(value.record);
      if (records.length > hardLimit) throw new Error(`Overview namespace exceeds ${hardLimit} records`);
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return records;
}

async function readOverviewRelations(path, limit) {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const byRank = new Map();
  try {
    for await (const line of lines) {
      if (!line) continue;
      const value = JSON.parse(line);
      if (!value || typeof value !== "object" || !value.record ||
          typeof value.record.entity_id !== "string") {
        throw new Error(`Overview relation row is invalid: ${path}`);
      }
      const rank = relationOverviewRank(value.record);
      const bucket = byRank.get(rank) ?? [];
      if (bucket.length < limit) bucket.push(value.record);
      byRank.set(rank, bucket);
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return [...byRank.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, relations]) => relations)
    .sort((left, right) =>
      relationOverviewRank(left) - relationOverviewRank(right) ||
      left.entity_id.localeCompare(right.entity_id, "en-US")
    )
    .slice(0, limit);
}

function parseArguments(argv) {
  const options = {
    canonicalManifest: null,
    outputDir: null,
    psqlCommand: "psql",
    generatedAt: null,
    gateAStatus: "not-run",
    gateAReportUrl: null,
    legacyCatalog: join(repositoryRoot, "data/published/rock-catalog-v2/canonical-catalog.json"),
  };
  const definitions = {
    "--canonical-manifest": "canonicalManifest",
    "--output-dir": "outputDir",
    "--psql-command": "psqlCommand",
    "--generated-at": "generatedAt",
    "--gate-a-status": "gateAStatus",
    "--gate-a-report-url": "gateAReportUrl",
    "--legacy-catalog": "legacyCatalog",
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const key = definitions[argument];
    if (!key) throw new Error(`Unknown argument: ${argument}`);
    if (seen.has(argument)) throw new Error(`${argument} may only be provided once`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    options[key] = value;
    seen.add(argument);
    index += 1;
  }
  if (!options.canonicalManifest || !options.outputDir || !options.legacyCatalog) {
    throw new Error("--canonical-manifest, --output-dir and --legacy-catalog are required");
  }
  if (![options.canonicalManifest, options.outputDir, options.legacyCatalog].every(isAbsolute)) {
    throw new Error("Canonical manifest, output directory and legacy catalog paths must be absolute");
  }
  if (!["not-run", "pass", "fail"].includes(options.gateAStatus)) {
    throw new Error("--gate-a-status must be not-run, pass or fail");
  }
  if (options.gateAStatus === "pass" && !options.gateAReportUrl) {
    throw new Error("--gate-a-status pass requires --gate-a-report-url");
  }
  return options;
}

function parseCanonicalManifest(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("Canonical manifest is malformed JSON"); }
  if (!value || value.manifest_version !== "1.0" ||
      value.mode !== "offline-canonical-postgres-project" ||
      value.projection_audit_passed !== true ||
      typeof value.generation_id !== "string" || typeof value.canonical_schema !== "string" ||
      typeof value.database !== "string" || !value.metrics || typeof value.metrics !== "object") {
    throw new Error("Canonical manifest contract mismatch");
  }
  return value;
}

function validateCanonicalCounts(manifest, counts) {
  const canonical = counts?.canonical;
  const expected = manifest.metrics;
  if (!canonical || typeof canonical !== "object" ||
      canonical.styles !== expected.published_styles ||
      canonical.artists !== expected.artists ||
      canonical.release_groups !== expected.release_groups ||
      canonical.relations !== expected.published_relations) {
    throw new Error("Canonical PostgreSQL counts do not match the audited manifest");
  }
}

function validateGateAOptions(options, generationId) {
  if (options.gateAStatus !== "pass") return;
  const slug = generationId.slice("mw:catalog-generation:".length);
  const expected = `/data/rock-catalog-v3/generations/${slug}/gate-a-report.json`;
  if (options.gateAReportUrl !== expected) {
    throw new Error(`--gate-a-report-url must equal ${expected}`);
  }
}

async function validateNewOutputDirectory(path) {
  if (!isAbsolute(path)) throw new Error("--output-dir must be absolute");
  const resolved = resolve(path);
  const parent = await realpath(dirname(resolved));
  if (parent === repositoryRoot || parent.startsWith(`${repositoryRoot}${sep}`)) {
    throw new Error("--output-dir must be outside the repository");
  }
  await stat(resolved).then(() => { throw new Error("--output-dir must not already exist"); }, (error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  return resolved;
}

async function validateRegularFile(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return realpath(path);
}

async function validatePsqlCommand(command) {
  await execFileAsync(command, ["--version"], { timeout: 5_000 }).catch(() => {
    throw new Error(`psql command is unavailable: ${command}`);
  });
  return command;
}

async function writeExclusive(path, bytes) {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (bytesWritten < 1) throw new Error("Frontend JSONL output stopped before the chunk completed");
    offset += bytesWritten;
  }
}

function toV3GenerationId(value) {
  const slug = value.toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("Canonical generation id cannot produce a V3 generation id");
  return `mw:catalog-generation:${slug}`;
}

function validateTimestamp(value, label) {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

function slug(value) {
  return String(value).toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
