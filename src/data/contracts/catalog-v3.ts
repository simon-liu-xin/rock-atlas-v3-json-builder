export const CATALOG_V3_CONTRACTS = {
  pointer: "3.0",
  schema: "3.0",
  layout: "global-v1",
  search_normalization: "search-normalization-v1",
  identity_normalization: "identity-normalization-v1",
  source_match_normalization: "source-match-normalization-v1",
  canonical_json: "canonical-json-v1",
} as const;

export interface VersionRange {
  readonly min: string;
  readonly max: string;
}

export interface CatalogPointerCompatibility {
  readonly schema: VersionRange;
  readonly layout: VersionRange;
  readonly search_normalization: string;
  readonly identity_normalization: string;
  readonly source_match_normalization: string;
  readonly canonical_json: string;
}

export interface CatalogPointerV3 {
  readonly pointer_version: "3.0";
  readonly channel: "rock-catalog-v3";
  readonly generation_id: string;
  readonly root_manifest_url: string;
  readonly root_manifest_content_sha256: string;
  readonly root_manifest_object_sha256: string;
  readonly compatibility: CatalogPointerCompatibility;
  readonly published_at: string;
  readonly key_id: string;
  readonly signature: string;
}

export interface CatalogClientCompatibility {
  readonly schema_versions: readonly string[];
  readonly layout_versions: readonly string[];
  readonly search_normalization_versions: readonly string[];
  readonly identity_normalization_versions: readonly string[];
  readonly source_match_normalization_versions: readonly string[];
  readonly canonical_json_versions: readonly string[];
}

export type CatalogCompatibilityResult =
  | { readonly compatible: true }
  | { readonly compatible: false; readonly reason: string };

export function normalizeSearchTextV1(value: string): string {
  return normalizeText(value);
}

export function normalizeIdentityNameV1(value: string): string {
  return normalizeText(value);
}

export function normalizeSourceMatchTextV1(value: string): string {
  return normalizeText(value);
}

export function canonicalJsonV1(value: unknown): string {
  return JSON.stringify(toCanonicalJsonValue(value));
}

export function isCatalogPointerCompatible(
  pointer: CatalogPointerV3,
  client: CatalogClientCompatibility,
): CatalogCompatibilityResult {
  const checks: ReadonlyArray<readonly [boolean, string]> = [
    [
      supportsRange(pointer.compatibility.schema, client.schema_versions),
      `schema version range ${pointer.compatibility.schema.min}..${pointer.compatibility.schema.max} is unsupported`,
    ],
    [
      supportsRange(pointer.compatibility.layout, client.layout_versions),
      `layout version range ${pointer.compatibility.layout.min}..${pointer.compatibility.layout.max} is unsupported`,
    ],
    [
      client.search_normalization_versions.includes(
        pointer.compatibility.search_normalization,
      ),
      `search normalization ${pointer.compatibility.search_normalization} is unsupported`,
    ],
    [
      client.identity_normalization_versions.includes(
        pointer.compatibility.identity_normalization,
      ),
      `identity normalization ${pointer.compatibility.identity_normalization} is unsupported`,
    ],
    [
      client.source_match_normalization_versions.includes(
        pointer.compatibility.source_match_normalization,
      ),
      `source match normalization ${pointer.compatibility.source_match_normalization} is unsupported`,
    ],
    [
      client.canonical_json_versions.includes(pointer.compatibility.canonical_json),
      `canonical JSON ${pointer.compatibility.canonical_json} is unsupported`,
    ],
  ];

  for (const [compatible, reason] of checks) {
    if (!compatible) return { compatible: false, reason };
  }
  return { compatible: true };
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function toCanonicalJsonValue(value: unknown): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical-json-v1 only supports finite numbers");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(toCanonicalJsonValue);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry === undefined) {
        throw new TypeError("canonical-json-v1 does not support undefined values");
      }
      output[key.normalize("NFC")] = toCanonicalJsonValue(entry);
    }
    return output;
  }
  throw new TypeError(`canonical-json-v1 does not support ${typeof value} values`);
}

function supportsRange(range: VersionRange, supportedVersions: readonly string[]): boolean {
  return supportedVersions.some(
    (version) => compareVersion(version, range.min) >= 0 && compareVersion(version, range.max) <= 0,
  );
}

function compareVersion(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const count = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart === rightPart) continue;
    if (typeof leftPart === "number" && typeof rightPart === "number") {
      return leftPart - rightPart;
    }
    return String(leftPart).localeCompare(String(rightPart), "en-US");
  }
  return 0;
}

function versionParts(value: string): Array<string | number> {
  return value
    .split(/([0-9]+)/u)
    .filter(Boolean)
    .map((part) => (/^[0-9]+$/u.test(part) ? Number(part) : part));
}
