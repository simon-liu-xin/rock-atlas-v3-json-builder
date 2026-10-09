import type { StyleRelationAssertionV2 } from "../../generated/schema-types.ts";
import { validateStyleRelationV2 } from "../../data/relations/style-relation-v2.ts";
import type { ExperimentSample } from "./candidate-model.ts";

const pipelineVersion = "legacy-v1-adapter-1";

export function adaptExperimentRelationsToV2(
  sample: ExperimentSample,
): StyleRelationAssertionV2[] {
  const evidenceById = new Map(
    sample.evidence.map((evidence) => [evidence.evidence_id, evidence]),
  );
  const styleIds = new Set(sample.styles.map((style) => style.internal_id));

  return sample.relations.map((relation) => {
    if (!styleIds.has(relation.source_id) || !styleIds.has(relation.target_id)) {
      throw new Error(
        `Legacy relation ${relation.internal_id} has unresolved style participants.`,
      );
    }

    const evidenceIds = nonEmpty(
      relation.evidence_ids,
      `Legacy relation ${relation.internal_id} has no evidence.`,
    );
    const evidence = evidenceIds.map((evidenceId) => {
      const record = evidenceById.get(evidenceId);
      if (!record) {
        throw new Error(
          `Legacy relation ${relation.internal_id} references missing evidence ${evidenceId}.`,
        );
      }
      return record;
    });
    const licensePartitions = unique(evidence.map((record) => record.license_partition));
    if (licensePartitions.length !== 1) {
      throw new Error(
        `Legacy relation ${relation.internal_id} crosses license partitions and cannot be upgraded.`,
      );
    }

    const normalized = normalizeLegacyShape(relation);
    const suffix = relation.internal_id.replace(/^mw:relation:/, "");
    const assertion: StyleRelationAssertionV2 = {
      assertion_id: `mw:assertion:${suffix}`,
      relation_id: relation.internal_id,
      claim_key: `mw:claim:${suffix}`,
      relation_type: normalized.relationType,
      direction: normalized.direction,
      participants: normalized.participants,
      assertion_kind: relation.assertion_kind,
      stance: "supports",
      review_status: relation.assertion_kind === "candidate" ? "unreviewed" : "accepted",
      metadata_completeness: "participants_only",
      claim_scope: { geographies: [], contexts: [] },
      time_context: null,
      confidence_band:
        relation.assertion_kind === "fact"
          ? "high"
          : relation.assertion_kind === "inferred"
            ? "medium"
            : "low",
      evidence_ids: evidenceIds,
      source_datasets: nonEmpty(
        unique(evidence.map((record) => record.source_dataset)),
        `Legacy relation ${relation.internal_id} has no source dataset.`,
      ),
      snapshot_version: sample.snapshot_id,
      pipeline_version: pipelineVersion,
      license_partition: licensePartitions[0]!,
    };

    validateStyleRelationV2(assertion);
    return assertion;
  });
}

interface LegacyRelationShape {
  relation_type: string;
  source_id: string;
  target_id: string;
  internal_id: string;
}

function normalizeLegacyShape(
  relation: LegacyRelationShape,
): Pick<StyleRelationAssertionV2, "direction" | "participants"> & {
  relationType: StyleRelationAssertionV2["relation_type"];
} {
  if (relation.relation_type === "hybrid_of" || relation.relation_type === "fusion_of") {
    throw new Error(
      `Binary ${relation.relation_type} relation ${relation.internal_id} cannot be upgraded to fusion without a supported joint claim.`,
    );
  }

  if (relation.relation_type === "influenced_by") {
    return directedShape("influences", relation.target_id, relation.source_id);
  }
  if (relation.relation_type === "likely_precedes") {
    return directedShape("evolves_into", relation.source_id, relation.target_id);
  }
  if (relation.relation_type === "candidate_subgenre_of") {
    return directedShape("subgenre_of", relation.source_id, relation.target_id);
  }
  if (
    relation.relation_type === "subgenre_of" ||
    relation.relation_type === "backlash_against"
  ) {
    return directedShape(relation.relation_type, relation.source_id, relation.target_id);
  }
  if (
    relation.relation_type === "associated_with" ||
    relation.relation_type === "sounds_like" ||
    relation.relation_type === "co_tagged_with"
  ) {
    return {
      relationType: relation.relation_type,
      direction: "undirected",
      participants: [
        { style_id: relation.source_id, role: "peer", ordinal: 0 },
        { style_id: relation.target_id, role: "peer", ordinal: 1 },
      ],
    };
  }

  throw new Error(
    `Unsupported legacy relation type ${relation.relation_type} in ${relation.internal_id}.`,
  );
}

function directedShape(
  relationType: Extract<
    StyleRelationAssertionV2["relation_type"],
    "evolves_into" | "influences" | "subgenre_of" | "backlash_against"
  >,
  sourceId: string,
  targetId: string,
): ReturnType<typeof normalizeLegacyShape> {
  return {
    relationType,
    direction: "directed",
    participants: [
      { style_id: sourceId, role: "source", ordinal: 0 },
      { style_id: targetId, role: "target", ordinal: 0 },
    ],
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function nonEmpty<T>(values: readonly T[], message: string): [T, ...T[]] {
  const [first, ...rest] = values;
  if (first === undefined) throw new Error(message);
  return [first, ...rest];
}
