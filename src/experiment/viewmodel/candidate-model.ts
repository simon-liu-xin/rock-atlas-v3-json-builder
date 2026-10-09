import type { CandidateViewModelV1 } from "../../generated/schema-types.ts";
import type { StyleRelationAssertionV2 } from "../../generated/schema-types.ts";

type CoverageState = CandidateViewModelV1["answer"]["coverage_state"];
type EmptyCandidateViewModel = Extract<CandidateViewModelV1, { relations: [] }>;
type ReadyCandidateViewModel = Exclude<CandidateViewModelV1, EmptyCandidateViewModel>;
type SourceValidationStatus = "cross_verified" | "single_source" | "curated";

interface ExperimentStyle {
  internal_id: string;
  canonical_name: string;
  era: string;
  region: string;
  artist_ids: string[];
  wikidata_qid: string;
  source_url: string;
  description?: string;
  source_revision_id?: string | null;
}

interface ExperimentArtist {
  internal_id: string;
  canonical_name: string;
  style_id: string;
  musicbrainz_mbid: string | null;
  source_url: string;
  canonical_entity_id?: string;
  wikidata_qid?: string | null;
  association_basis?: "curated-seed" | "wikidata-direct-genre" | "wikidata-ancestor-fallback";
  asserted_style_id?: string;
  ancestor_distance?: number;
  evidence_id?: string;
  validation_status?: SourceValidationStatus;
  verified_sources?: string[];
}

interface ExperimentReleaseGroup {
  internal_id: string;
  canonical_name: string;
  artist_ids: string[];
  primary_type: string;
  secondary_types: string[];
  first_release_date: string | null;
  musicbrainz_mbid: string | null;
  source_url: string;
  canonical_entity_id?: string;
  wikidata_qid?: string | null;
  evidence_id?: string;
  validation_status?: SourceValidationStatus;
  verified_sources?: string[];
}

interface ExperimentRecording {
  internal_id: string;
  canonical_name: string;
  artist_ids: string[];
  first_release_date: string | null;
  length_ms: number | null;
  musicbrainz_mbid: string;
  source_url: string;
}

interface ExperimentRelation {
  internal_id: string;
  source_id: string;
  target_id: string;
  relation_type: CandidateViewModelV1["relations"][number]["relation_type"];
  direction: CandidateViewModelV1["relations"][number]["direction"];
  assertion_kind: CandidateViewModelV1["relations"][number]["assertion_kind"];
  label: string;
  summary: string;
  score: number | null;
  coverage_state: CoverageState;
  evidence_ids: string[];
}

interface ExperimentEvidence {
  evidence_id: string;
  source_dataset: string;
  source_record_id: string;
  source_url: string;
  claim: string;
  retrieved_at: string;
  snapshot_version: string;
  license_partition: string;
}

export interface ExperimentPath {
  path_id: string;
  question: { focus_id: string; text: string };
  answer: { summary: string; coverage_state: CoverageState };
  relation_ids: string[];
  artist_ids: string[];
  recording_artist_id: string;
  next_path_id: string;
}

export interface ExperimentSample {
  schema_version: "1.0";
  catalog_version?: "2.0";
  snapshot_id: string;
  generated_at?: string;
  source_fingerprint_sha256?: string;
  preserved_seed_artist_count?: number;
  sampling_note: string;
  styles: ExperimentStyle[];
  artists: ExperimentArtist[];
  release_groups: ExperimentReleaseGroup[];
  recordings: ExperimentRecording[];
  relations: ExperimentRelation[];
  style_relations_v2?: StyleRelationAssertionV2[];
  evidence: ExperimentEvidence[];
  paths: ExperimentPath[];
  required_partitions: CandidateViewModelV1["required_partitions"];
}

export function buildCandidateViewModel(
  sample: ExperimentSample,
  pathId: string,
): CandidateViewModelV1 {
  const path = sample.paths.find((candidate) => candidate.path_id === pathId);
  if (!path) throw new Error(`Unknown experiment path ${pathId}.`);

  const styles = new Map(sample.styles.map((style) => [style.internal_id, style]));
  const relations = path.relation_ids.map((relationId) => {
    const relation = requiredById(sample.relations, relationId, "relation");
    return {
      ...relation,
      source_name: requiredById(styles, relation.source_id, "style").canonical_name,
      target_name: requiredById(styles, relation.target_id, "style").canonical_name,
      evidence_ids: [...relation.evidence_ids],
    };
  });
  const artists = path.artist_ids.map((artistId) => {
    const artist = requiredById(sample.artists, artistId, "artist");
    return {
      internal_id: artist.internal_id,
      canonical_name: artist.canonical_name,
      style_id: artist.style_id,
      source_url: safeExternalUrl(artist.source_url),
    };
  });
  const recordings = sample.recordings
    .filter((recording) => recording.artist_ids.includes(path.recording_artist_id))
    .map((recording) => ({
      internal_id: recording.internal_id,
      canonical_name: recording.canonical_name,
      artist_ids: [...recording.artist_ids] as [string, ...string[]],
      first_release_date: recording.first_release_date,
      length_ms: recording.length_ms,
      source_url: safeExternalUrl(recording.source_url),
    }));

  const evidenceIds = [
    ...new Set(relations.flatMap((relation) => relation.evidence_ids)),
  ];
  const evidence = evidenceIds.map((evidenceId) => {
    const record = requiredById(sample.evidence, evidenceId, "evidence");
    return {
      ...record,
      source_url: safeExternalUrl(record.source_url, true),
    };
  });
  const focusId = path.question.focus_id;
  const semanticQuery = new URLSearchParams({
    snapshot: sample.snapshot_id,
    path: path.path_id,
    focus_id: focusId,
  }).toString();
  const firstArtist = artists[0];
  const firstRecording = recordings[0];
  if (
    !firstArtist ||
    !firstRecording ||
    (relations.length !== 0 && relations.length !== 3)
  ) {
    throw new Error(`${path.path_id} does not satisfy the candidate action contract.`);
  }

  const actions = [
    ...relations.map((relation, index) => ({
      action_id: `mw:action:open-relation-${index + 1}`,
      action_type: "open_relation" as const,
      label: "candidate.action.openRelation",
      target_id: relation.internal_id,
      href: `/experiment?${semanticQuery}&relation_id=${encodeURIComponent(relation.internal_id)}`,
    })),
    {
      action_id: "mw:action:open-artist",
      action_type: "open_artist" as const,
      label: "candidate.action.openArtist",
      target_id: firstArtist.internal_id,
      href: `/experiment?${semanticQuery}&artist_id=${encodeURIComponent(firstArtist.internal_id)}`,
    },
    {
      action_id: "mw:action:open-recording",
      action_type: "open_recording" as const,
      label: "candidate.action.openRecording",
      target_id: firstRecording.internal_id,
      href: firstRecording.source_url,
    },
    {
      action_id: "mw:action:next-hop",
      action_type: "next_hop" as const,
      label: "candidate.action.nextHop",
      target_id: path.next_path_id,
      href: `/experiment?${new URLSearchParams({ snapshot: sample.snapshot_id, path: path.next_path_id }).toString()}`,
    },
    {
      action_id: "mw:action:share",
      action_type: "share" as const,
      label: "candidate.action.share",
      target_id: null,
      href: `/experiment?${semanticQuery}`,
    },
  ];

  const common = {
    view_model_version: "1.0" as const,
    snapshot_id: sample.snapshot_id,
    path_id: path.path_id,
    question: { ...path.question },
    answer: { ...path.answer },
    artists: artists as CandidateViewModelV1["artists"],
    recordings,
    required_partitions: sample.required_partitions.map((partition) => ({
      ...partition,
    })) as CandidateViewModelV1["required_partitions"],
    share_state: {
      canonical_path: "/experiment",
      snapshot: sample.snapshot_id,
      focus_id: focusId,
      path_id: path.path_id,
    },
  };
  if (relations.length === 0) {
    if (evidence.length !== 0 || actions.length !== 4) {
      throw new Error(`${path.path_id} does not satisfy the empty candidate contract.`);
    }
    return {
      ...common,
      relations: [],
      evidence: [],
      actions: actions as EmptyCandidateViewModel["actions"],
    };
  }
  if (relations.length !== 3 || evidence.length === 0 || actions.length !== 7) {
    throw new Error(`${path.path_id} does not satisfy the ready candidate contract.`);
  }
  return {
    ...common,
    relations: relations as ReadyCandidateViewModel["relations"],
    evidence: evidence as ReadyCandidateViewModel["evidence"],
    actions: actions as ReadyCandidateViewModel["actions"],
  };
}

function safeExternalUrl(value: string, allowRepositoryDocument = false): string {
  if (allowRepositoryDocument && /^docs\/[a-z0-9_./-]+\.md(?:#[a-z0-9_-]+)?$/i.test(value) && !value.includes("..")) {
    return value;
  }
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname && !url.username && !url.password) return url.toString();
  } catch {
    // The common error below keeps the public failure contract stable.
  }
  throw new Error(`Unsafe external URL in candidate data: ${value}`);
}

function requiredById<T extends { internal_id?: string; evidence_id?: string }>(
  collection: T[] | Map<string, T>,
  id: string,
  kind: string,
): T {
  const value = collection instanceof Map
    ? collection.get(id)
    : collection.find((item) => item.internal_id === id || item.evidence_id === id);
  if (!value) throw new Error(`Missing ${kind} ${id}.`);
  return value;
}
