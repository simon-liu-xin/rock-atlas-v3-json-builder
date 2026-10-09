export const CATALOG_GATE_A_REQUIRED_CHECKS = [
  "contracts",
  "postgres-v3",
  "semantics-license",
  "exporter",
  "publication",
  "recovery-nightly",
  "repository-conformance",
  "v2-regression",
  "runtime-pr",
  "full-motion-nightly",
] as const;

export type CatalogGateACheckId = (typeof CATALOG_GATE_A_REQUIRED_CHECKS)[number];

export interface CatalogGateAEvidence {
  readonly evidence_version: "1.0";
  readonly check_id: CatalogGateACheckId;
  readonly status: "pass" | "fail";
  readonly commit: string;
  readonly contains_commits?: readonly string[];
  readonly recorded_at: string;
  readonly artifact_path: string;
  readonly metrics?: Readonly<Record<string, number | string | boolean | null>>;
}

export interface CatalogGateAReport {
  readonly report_version: "3.0";
  readonly gate: "A";
  readonly commit: string;
  readonly generated_at: string;
  readonly status: "pass" | "fail";
  readonly readiness: {
    readonly v3_architecture_ready: boolean;
    readonly full_catalog_ready: false;
    readonly graph_database_ready: false;
  };
  readonly v2_pointer_unchanged: boolean;
  readonly checks: readonly {
    readonly check_id: CatalogGateACheckId;
    readonly status: "pass" | "fail" | "missing";
    readonly artifact_path: string | null;
    readonly reason: string | null;
  }[];
  readonly blockers: readonly string[];
}

const NIGHTLY_CHECKS = new Set<CatalogGateACheckId>([
  "recovery-nightly",
  "full-motion-nightly",
]);

export function buildCatalogGateAReport(input: {
  readonly commit: string;
  readonly generated_at: string;
  readonly evidence: readonly CatalogGateAEvidence[];
  readonly v2_pointer_before_sha256: string;
  readonly v2_pointer_after_sha256: string;
}): CatalogGateAReport {
  assertSha(input.v2_pointer_before_sha256, "v2_pointer_before_sha256");
  assertSha(input.v2_pointer_after_sha256, "v2_pointer_after_sha256");
  const generatedAt = timestamp(input.generated_at, "generated_at");
  const byId = new Map<CatalogGateACheckId, CatalogGateAEvidence>();
  for (const evidence of input.evidence) {
    if (byId.has(evidence.check_id)) throw new Error(`Duplicate Gate A evidence ${evidence.check_id}`);
    byId.set(evidence.check_id, evidence);
  }

  const checks = CATALOG_GATE_A_REQUIRED_CHECKS.map((checkId) => {
    const evidence = byId.get(checkId);
    if (!evidence) {
      return { check_id: checkId, status: "missing" as const, artifact_path: null, reason: "required evidence is missing" };
    }
    if (evidence.commit !== input.commit && !evidence.contains_commits?.includes(input.commit)) {
      return { check_id: checkId, status: "fail" as const, artifact_path: evidence.artifact_path, reason: "evidence does not cover target commit" };
    }
    if (evidence.status !== "pass") {
      return { check_id: checkId, status: "fail" as const, artifact_path: evidence.artifact_path, reason: "evidence reported failure" };
    }
    const recordedAt = timestamp(evidence.recorded_at, `${checkId}.recorded_at`);
    if (NIGHTLY_CHECKS.has(checkId) && (generatedAt - recordedAt < 0 || generatedAt - recordedAt > 24 * 60 * 60 * 1_000)) {
      return { check_id: checkId, status: "fail" as const, artifact_path: evidence.artifact_path, reason: "nightly evidence is older than 24 hours" };
    }
    return { check_id: checkId, status: "pass" as const, artifact_path: evidence.artifact_path, reason: null };
  });
  const pointerUnchanged = input.v2_pointer_before_sha256 === input.v2_pointer_after_sha256;
  const blockers = [
    ...checks.filter((check) => check.status !== "pass").map((check) => `${check.check_id}: ${check.reason}`),
    ...(pointerUnchanged ? [] : ["v2-pointer: V2 production pointer changed during Gate A"]),
  ];
  const passed = blockers.length === 0;
  return {
    report_version: "3.0",
    gate: "A",
    commit: input.commit,
    generated_at: input.generated_at,
    status: passed ? "pass" : "fail",
    readiness: {
      v3_architecture_ready: passed,
      full_catalog_ready: false,
      graph_database_ready: false,
    },
    v2_pointer_unchanged: pointerUnchanged,
    checks,
    blockers,
  };
}

function assertSha(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${field} must be a SHA-256 hex digest`);
}

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be an ISO timestamp`);
  return parsed;
}
