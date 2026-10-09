import { MusicWikiError } from "../../errors.ts";

export interface StyleRelationParticipantV2Like {
  style_id: string;
  role: "source" | "target" | "peer";
  ordinal: number;
}

export interface StyleRelationV2Like {
  assertion_id: string;
  relation_id: string;
  claim_key: string;
  relation_type: string;
  direction: "directed" | "undirected";
  participants: readonly StyleRelationParticipantV2Like[];
  assertion_kind: "fact" | "inferred" | "candidate";
  stance: "supports" | "disputes";
  review_status: "accepted" | "contested" | "rejected" | "unreviewed";
  metadata_completeness: "participants_only" | "partial_context" | "contextualized";
  claim_scope: {
    geographies: readonly string[];
    contexts: readonly string[];
  };
  time_context: {
    start: string | null;
    end: string | null;
    precision: "instant" | "range" | "decade" | "unknown";
  } | null;
  confidence_band: "low" | "medium" | "high";
  evidence_ids: readonly string[];
  source_datasets: readonly string[];
  snapshot_version: string;
  pipeline_version: string;
  license_partition: string;
}

const directedRelationTypes = new Set([
  "evolves_into",
  "fusion_of",
  "influences",
  "subgenre_of",
  "backlash_against",
]);

const undirectedRelationTypes = new Set([
  "associated_with",
  "sounds_like",
  "co_tagged_with",
  "unrelated_within_scope",
]);

export function validateStyleRelationV2(relation: StyleRelationV2Like): void {
  const styleIds = relation.participants.map((participant) => participant.style_id);
  if (new Set(styleIds).size !== styleIds.length) {
    throw relationInvalid(relation, "Relation has a duplicate style participant.");
  }

  const ordinalKeys = relation.participants.map(
    (participant) => `${participant.role}:${participant.ordinal}`,
  );
  if (new Set(ordinalKeys).size !== ordinalKeys.length) {
    throw relationInvalid(relation, "Relation has a duplicate role ordinal.");
  }

  const sources = relation.participants.filter((participant) => participant.role === "source");
  const targets = relation.participants.filter((participant) => participant.role === "target");
  const peers = relation.participants.filter((participant) => participant.role === "peer");

  if (directedRelationTypes.has(relation.relation_type) && relation.direction !== "directed") {
    throw relationInvalid(relation, `${relation.relation_type} must be directed.`);
  }
  if (undirectedRelationTypes.has(relation.relation_type) && relation.direction !== "undirected") {
    throw relationInvalid(relation, `${relation.relation_type} must be undirected.`);
  }

  if (relation.relation_type === "fusion_of") {
    if (sources.length < 2) {
      throw relationInvalid(relation, "Fusion requires at least two source participants.");
    }
    if (targets.length !== 1) {
      throw relationInvalid(relation, "Fusion requires exactly one target participant.");
    }
    if (peers.length !== 0) {
      throw relationInvalid(relation, "Fusion cannot contain peer participants.");
    }
  } else if (relation.direction === "directed") {
    if (sources.length !== 1 || targets.length !== 1 || peers.length !== 0) {
      throw relationInvalid(
        relation,
        "A directed non-fusion relation requires one source and one target.",
      );
    }
  } else if (sources.length !== 0 || targets.length !== 0 || peers.length !== 2) {
    throw relationInvalid(relation, "An undirected relation requires exactly two peers.");
  }

  if (relation.relation_type === "unrelated_within_scope") {
    if (
      relation.claim_scope.geographies.length === 0 &&
      relation.claim_scope.contexts.length === 0
    ) {
      throw relationInvalid(relation, "Explicit non-relation requires an explicit claim scope.");
    }
    if (
      relation.stance === "supports" &&
      relation.review_status === "accepted" &&
      relation.assertion_kind !== "fact"
    ) {
      throw relationInvalid(
        relation,
        "An accepted supporting non-relation must be a fact.",
      );
    }
  }
}

function relationInvalid(relation: StyleRelationV2Like, cause: string): MusicWikiError {
  return new MusicWikiError({
    code: "MW_ASSERTION_INVALID",
    exitCode: 4,
    message: "Style relation v2 is invalid.",
    cause,
    hint: "Correct participant roles, cardinality, direction, or scope before publishing.",
    docsUrl: "docs/data/style-relation-hypergraph-v2.md#validation-rules",
    details: { relation_id: relation.relation_id },
  });
}
