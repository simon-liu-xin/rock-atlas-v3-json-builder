import { createHash } from "node:crypto";

import type {
  RelationDetail,
  StyleSummary,
  UniverseOverview,
} from "../catalog/catalog-repository.ts";

export const FULL_FRONTEND_NAMESPACES = [
  "style-summary",
  "style-artists",
  "style-relations",
  "artist-summary",
  "artist-release-groups",
  "release-group-summary",
  "relation",
  "evidence",
  "identity-resolution",
  "search-style",
  "search-artist",
  "search-release-group",
] as const;

export type FullFrontendNamespace = typeof FULL_FRONTEND_NAMESPACES[number];
export const FULL_OVERVIEW_RELATION_LIMIT = 1_500;

export interface LegacyIdentityCandidate {
  readonly from_id: string;
  readonly namespace: "wikidata-item" | "musicbrainz-artist" | "musicbrainz-release-group";
  readonly external_id: string;
}

export function fullCatalogLegacyResolutionSql(
  schema: string,
  candidates: readonly LegacyIdentityCandidate[],
): string {
  const s = quoteSchema(schema);
  if (candidates.length === 0) return "SELECT '[]'::json::text";
  const values = candidates.map((candidate) => {
    if (!/^mw:(?:style|artist|release-group):[a-z0-9][a-z0-9._:-]*$/u.test(candidate.from_id) ||
        !/^[a-z][a-z0-9-]*$/u.test(candidate.namespace) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(candidate.external_id)) {
      throw new Error("Invalid legacy identity candidate");
    }
    return `(${sqlLiteral(candidate.from_id)}, ${sqlLiteral(candidate.namespace)}, ${sqlLiteral(candidate.external_id)})`;
  }).join(",\n");
  return `WITH requested(from_id, namespace, external_id) AS (VALUES
${values}
), resolved AS (
  SELECT requested.from_id, min(identity.internal_id) AS entity_id
  FROM requested
  JOIN ${s}.external_identity identity
    ON identity.namespace = requested.namespace
   AND lower(identity.external_id) = lower(requested.external_id)
   AND identity.assertion_status = 'accepted'
  GROUP BY requested.from_id
  HAVING count(DISTINCT identity.internal_id) = 1
)
SELECT COALESCE(json_agg(json_build_object(
  'from_id', from_id,
  'entity_id', entity_id
) ORDER BY from_id), '[]'::json)::text FROM resolved`;
}

export function fullCatalogNamespaceSql(
  namespace: FullFrontendNamespace,
  schema: string,
): string {
  const s = quoteSchema(schema);
  switch (namespace) {
    case "style-summary":
      return `
WITH membership AS (${artistStyleMembershipSql(s)}), counts AS (
  SELECT style_id, count(DISTINCT artist_id)::integer AS artist_count
  FROM membership GROUP BY style_id
), wikidata_style AS (
  SELECT internal_id, source_metadata->>'wikidata_qid' AS qid
  FROM ${s}.style
  WHERE source_metadata ? 'wikidata_qid'
    AND inclusion_status = 'accepted' AND retired_at IS NULL
)
SELECT json_build_object(
  'id', style.internal_id,
  'record', json_build_object(
    'entity_id', style.internal_id,
    'name', style.canonical_name,
    'description', NULLIF(style.description, ''),
    'era', style.origin_date_text,
    'region', style.region_text,
    'source_url', NULLIF(style.source_metadata->>'source_url', ''),
    'artist_count', COALESCE(counts.artist_count, 0),
    'parent_style_ids', COALESCE(ARRAY(
      SELECT parent.internal_id
      FROM jsonb_array_elements_text(
        COALESCE(style.source_metadata->'parent_qids', '[]'::jsonb)
      ) AS parent_qid(qid)
      JOIN wikidata_style parent ON parent.qid = parent_qid.qid
      ORDER BY parent.internal_id
    ), ARRAY[]::text[])
  )
)::text
FROM ${s}.style style
LEFT JOIN counts ON counts.style_id = style.internal_id
WHERE style.inclusion_status = 'accepted' AND style.retired_at IS NULL
ORDER BY style.internal_id`;
    case "artist-summary":
      return `
WITH membership AS (${artistStyleMembershipSql(s)}), grouped AS (
  SELECT artist_id, array_agg(DISTINCT style_id ORDER BY style_id) AS style_ids
  FROM membership GROUP BY artist_id
)
SELECT json_build_object(
  'id', artist.internal_id,
  'record', json_build_object(
    'entity_id', artist.internal_id,
    'name', artist.canonical_name,
    'style_ids', COALESCE(grouped.style_ids, ARRAY[]::text[]),
    'source_url', NULLIF(artist.source_metadata->>'source_url', ''),
    'description', NULLIF(artist.description, ''),
    'artist_type', artist.artist_type,
    'begin_date', artist.begin_date_text,
    'end_date', artist.end_date_text,
    'country_code', artist.country_code
  )
)::text
FROM ${s}.artist artist
LEFT JOIN grouped ON grouped.artist_id = artist.internal_id
WHERE artist.retired_at IS NULL
ORDER BY artist.internal_id`;
    case "release-group-summary":
      return `
WITH credits AS (
  SELECT release_group_id,
    array_agg(artist_id ORDER BY credit_position) AS artist_ids
  FROM ${s}.release_group_artist GROUP BY release_group_id
)
SELECT json_build_object(
  'id', release_group.internal_id,
  'record', json_build_object(
    'entity_id', release_group.internal_id,
    'name', release_group.canonical_name,
    'artist_ids', COALESCE(credits.artist_ids, ARRAY[]::text[]),
    'primary_type', NULLIF(release_group.primary_type, ''),
    'secondary_types', release_group.secondary_types,
    'first_release_date', release_group.first_release_date_text,
    'source_url', NULLIF(release_group.source_metadata->>'source_url', ''),
    'description', NULLIF(release_group.description, ''),
    'cover_art_url', release_group.cover_art_url
  )
)::text
FROM ${s}.release_group release_group
LEFT JOIN credits ON credits.release_group_id = release_group.internal_id
WHERE release_group.retired_at IS NULL
ORDER BY release_group.internal_id`;
    case "style-artists":
      return `
WITH membership AS (${artistStyleMembershipSql(s)}), distinct_membership AS (
  SELECT DISTINCT style_id, artist_id FROM membership
), ranked AS (
  SELECT membership.style_id, membership.artist_id,
    row_number() OVER (PARTITION BY membership.style_id ORDER BY artist.sort_name, artist.internal_id) - 1 AS row_index,
    count(*) OVER (PARTITION BY membership.style_id) AS total_count,
    json_build_object(
      'entity_id', artist.internal_id,
      'name', artist.canonical_name,
      'style_ids', ARRAY[membership.style_id],
      'source_url', NULLIF(artist.source_metadata->>'source_url', ''),
      'description', NULLIF(artist.description, ''),
      'artist_type', artist.artist_type,
      'begin_date', artist.begin_date_text,
      'end_date', artist.end_date_text,
      'country_code', artist.country_code
    ) AS item
  FROM distinct_membership membership
  JOIN ${s}.artist artist ON artist.internal_id = membership.artist_id
  WHERE artist.retired_at IS NULL
), pages AS (
  SELECT style_id, floor(row_index / 60)::integer AS page_index,
    max(total_count)::integer AS total_count,
    json_agg(item ORDER BY row_index) AS items
  FROM ranked GROUP BY style_id, floor(row_index / 60)::integer
), all_pages AS (
  SELECT style_id, page_index, total_count, items FROM pages
  UNION ALL
  SELECT style.internal_id, 0, 0, '[]'::json
  FROM ${s}.style style
  WHERE style.inclusion_status = 'accepted' AND style.retired_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM ranked WHERE ranked.style_id = style.internal_id)
)
SELECT json_build_object(
  'id', style_id || ':page:' || page_index,
  'record', json_build_object(
    'items', items,
    'next_offset', CASE WHEN (page_index + 1) * 60 < total_count THEN (page_index + 1) * 60 ELSE NULL END
  )
)::text
FROM all_pages ORDER BY style_id, page_index`;
    case "artist-release-groups":
      return `
WITH ranked AS (
  SELECT credit.artist_id, release_group.internal_id,
    row_number() OVER (
      PARTITION BY credit.artist_id
      ORDER BY release_group.first_release_date_text NULLS LAST, lower(release_group.canonical_name), release_group.internal_id
    ) - 1 AS row_index,
    count(*) OVER (PARTITION BY credit.artist_id) AS total_count,
    json_build_object(
      'entity_id', release_group.internal_id,
      'name', release_group.canonical_name,
      'artist_ids', ARRAY(SELECT c.artist_id FROM ${s}.release_group_artist c
        WHERE c.release_group_id = release_group.internal_id ORDER BY c.credit_position),
      'primary_type', NULLIF(release_group.primary_type, ''),
      'secondary_types', release_group.secondary_types,
      'first_release_date', release_group.first_release_date_text,
      'source_url', NULLIF(release_group.source_metadata->>'source_url', ''),
      'description', NULLIF(release_group.description, ''),
      'cover_art_url', release_group.cover_art_url
    ) AS item
  FROM ${s}.release_group_artist credit
  JOIN ${s}.release_group release_group ON release_group.internal_id = credit.release_group_id
  WHERE release_group.retired_at IS NULL
), pages AS (
  SELECT artist_id, floor(row_index / 24)::integer AS page_index,
    max(total_count)::integer AS total_count,
    json_agg(item ORDER BY row_index) AS items
  FROM ranked GROUP BY artist_id, floor(row_index / 24)::integer
), all_pages AS (
  SELECT artist_id, page_index, total_count, items FROM pages
  UNION ALL
  SELECT artist.internal_id, 0, 0, '[]'::json
  FROM ${s}.artist artist
  WHERE artist.retired_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM ranked WHERE ranked.artist_id = artist.internal_id)
)
SELECT json_build_object(
  'id', artist_id || ':page:' || page_index,
  'record', json_build_object(
    'items', items,
    'next_offset', CASE WHEN (page_index + 1) * 24 < total_count THEN (page_index + 1) * 24 ELSE NULL END
  )
)::text
FROM all_pages ORDER BY artist_id, page_index`;
    case "style-relations":
      return `
WITH accepted AS (
  SELECT * FROM (
    SELECT assertion.*,
      row_number() OVER (
        PARTITION BY assertion.relation_id
        ORDER BY CASE assertion.assertion_kind WHEN 'fact' THEN 0 WHEN 'inferred' THEN 1 ELSE 2 END,
          CASE assertion.confidence_band WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
          assertion.assertion_id
      ) AS assertion_rank
    FROM ${s}.style_relation_assertion_v2 assertion
    WHERE assertion.stance = 'supports' AND assertion.review_status = 'accepted'
      AND NOT EXISTS (
        SELECT 1
        FROM ${s}.style_relation_participant participant
        JOIN ${s}.style style ON style.internal_id = participant.style_id
        WHERE participant.relation_id = assertion.relation_id
          AND (style.inclusion_status <> 'accepted' OR style.retired_at IS NOT NULL)
      )
  ) ranked WHERE assertion_rank = 1
), participants AS (
  SELECT relation_id, json_agg(json_build_object(
    'style_id', style_id,
    'role', participant_role,
    'ordinal', ordinal
  ) ORDER BY participant_role, ordinal, style_id) AS value
  FROM ${s}.style_relation_participant GROUP BY relation_id
), relation_records AS (
  SELECT relation.relation_id, json_build_object(
    'entity_id', relation.relation_id,
    'relation_type', relation.relation_kind,
    'direction', relation.direction,
    'participants', participants.value,
    'assertion_kind', accepted.assertion_kind,
    'confidence_band', accepted.confidence_band,
    'source_datasets', accepted.source_datasets,
    'assertion', ${relationAssertionSql(s)},
    'evidence_ids', COALESCE((
      SELECT json_agg(link.evidence_id ORDER BY link.evidence_id)
      FROM ${s}.style_relation_assertion_evidence_v2 link
      WHERE link.assertion_id = accepted.assertion_id
    ), '[]'::json)
  ) AS item
  FROM ${s}.style_relation relation
  JOIN accepted ON accepted.relation_id = relation.relation_id
  JOIN participants ON participants.relation_id = relation.relation_id
), ranked AS (
  SELECT participant.style_id, relation_records.relation_id, relation_records.item,
    row_number() OVER (
      PARTITION BY participant.style_id ORDER BY relation_records.relation_id
    ) - 1 AS row_index,
    count(*) OVER (PARTITION BY participant.style_id) AS total_count
  FROM relation_records
  JOIN ${s}.style_relation_participant participant
    ON participant.relation_id = relation_records.relation_id
), pages AS (
  SELECT style_id, floor(row_index / 60)::integer AS page_index,
    max(total_count)::integer AS total_count,
    json_agg(item ORDER BY row_index) AS items
  FROM ranked GROUP BY style_id, floor(row_index / 60)::integer
), all_pages AS (
  SELECT style_id, page_index, total_count, items FROM pages
  UNION ALL
  SELECT style.internal_id, 0, 0, '[]'::json
  FROM ${s}.style style
  WHERE style.inclusion_status = 'accepted' AND style.retired_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM ranked WHERE ranked.style_id = style.internal_id)
)
SELECT json_build_object(
  'id', style_id || ':page:' || page_index,
  'record', json_build_object(
    'items', items,
    'next_offset', CASE WHEN (page_index + 1) * 60 < total_count THEN (page_index + 1) * 60 ELSE NULL END
  )
)::text
FROM all_pages ORDER BY style_id, page_index`;
    case "relation":
      return `
WITH accepted AS (
  SELECT * FROM (
    SELECT assertion.*,
      row_number() OVER (
        PARTITION BY assertion.relation_id
        ORDER BY CASE assertion.assertion_kind WHEN 'fact' THEN 0 WHEN 'inferred' THEN 1 ELSE 2 END,
          CASE assertion.confidence_band WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
          assertion.assertion_id
      ) AS assertion_rank
    FROM ${s}.style_relation_assertion_v2 assertion
    WHERE assertion.stance = 'supports' AND assertion.review_status = 'accepted'
      AND NOT EXISTS (
        SELECT 1
        FROM ${s}.style_relation_participant participant
        JOIN ${s}.style style ON style.internal_id = participant.style_id
        WHERE participant.relation_id = assertion.relation_id
          AND (style.inclusion_status <> 'accepted' OR style.retired_at IS NOT NULL)
      )
  ) ranked WHERE assertion_rank = 1
), participants AS (
  SELECT relation_id, json_agg(json_build_object(
    'style_id', style_id,
    'role', participant_role,
    'ordinal', ordinal
  ) ORDER BY participant_role, ordinal, style_id) AS value
  FROM ${s}.style_relation_participant GROUP BY relation_id
)
SELECT json_build_object(
  'id', relation.relation_id,
  'record', json_build_object(
    'entity_id', relation.relation_id,
    'relation_type', relation.relation_kind,
    'direction', relation.direction,
    'participants', participants.value,
    'assertion_kind', accepted.assertion_kind,
    'confidence_band', accepted.confidence_band,
    'source_datasets', accepted.source_datasets,
    'assertion', ${relationAssertionSql(s)},
    'evidence_ids', COALESCE((
      SELECT json_agg(link.evidence_id ORDER BY link.evidence_id)
      FROM ${s}.style_relation_assertion_evidence_v2 link
      WHERE link.assertion_id = accepted.assertion_id
    ), '[]'::json)
  )
)::text
FROM ${s}.style_relation relation
JOIN accepted ON accepted.relation_id = relation.relation_id
JOIN participants ON participants.relation_id = relation.relation_id
ORDER BY relation.relation_id`;
    case "evidence":
      return `
SELECT json_build_object(
  'id', evidence.evidence_id,
  'record', json_build_object(
    'evidence_id', evidence.evidence_id,
    'source_dataset', evidence.source_dataset,
    'source_record_id', evidence.source_record_id,
    'source_url', evidence.source_url,
    'claim', evidence.claim_text,
    'retrieved_at', evidence.retrieved_at,
    'snapshot_version', evidence.snapshot_version,
    'license_partition', evidence.license_partition
  )
)::text
FROM (
  SELECT evidence_id, source_dataset, source_record_id, source_url, claim_text,
    retrieved_at, snapshot_version, license_partition, 0 AS source_priority
  FROM ${s}.catalog_evidence
  UNION ALL
  SELECT evidence.evidence_id, evidence.source_dataset, evidence.source_record_id,
    evidence.source_url, evidence.claim_text, evidence.retrieved_at,
    COALESCE(snapshot.upstream_version, evidence.source_snapshot_id),
    evidence.license_partition, 1 AS source_priority
  FROM ${s}.style_relation_evidence evidence
  LEFT JOIN ${s}.source_snapshot snapshot ON snapshot.snapshot_id = evidence.source_snapshot_id
) evidence
WHERE NOT EXISTS (
  SELECT 1 FROM ${s}.catalog_evidence preferred
  WHERE preferred.evidence_id = evidence.evidence_id AND evidence.source_priority > 0
)
ORDER BY evidence.evidence_id`;
    case "identity-resolution":
      return `
SELECT json_build_object(
  'id', identity.internal_id,
  'record', json_build_object('status', 'current', 'entity_id', identity.internal_id)
)::text
FROM (SELECT NULL::text AS internal_id) identity WHERE false`;
    case "search-style":
      return searchSql(s, "style", "style", "inclusion_status = 'accepted' AND retired_at IS NULL");
    case "search-artist":
      return searchSql(s, "artist", "artist", "retired_at IS NULL");
    case "search-release-group":
      return searchSql(s, "release_group", "release-group", "retired_at IS NULL");
  }
}

export function fullCatalogCountsSql(schema: string): string {
  const s = quoteSchema(schema);
  return `SELECT json_build_object(
    'canonical', json_build_object(
      'styles', (SELECT count(*) FROM ${s}.style WHERE inclusion_status = 'accepted' AND retired_at IS NULL),
      'artists', (SELECT count(*) FROM ${s}.artist WHERE retired_at IS NULL),
      'release_groups', (SELECT count(*) FROM ${s}.release_group WHERE retired_at IS NULL),
      'relations', (SELECT count(DISTINCT assertion.relation_id)
        FROM ${s}.style_relation_assertion_v2 assertion
        WHERE assertion.stance = 'supports' AND assertion.review_status = 'accepted'
          AND NOT EXISTS (
            SELECT 1 FROM ${s}.style_relation_participant participant
            JOIN ${s}.style style ON style.internal_id = participant.style_id
            WHERE participant.relation_id = assertion.relation_id
              AND (style.inclusion_status <> 'accepted' OR style.retired_at IS NOT NULL)
          )),
      'evidence', (SELECT count(*) FROM (
        SELECT evidence_id FROM ${s}.catalog_evidence
        UNION SELECT evidence_id FROM ${s}.style_relation_evidence
      ) all_evidence)
    ),
    'projections', json_build_object(
      'overview_styles', (SELECT count(*) FROM ${s}.style WHERE inclusion_status = 'accepted' AND retired_at IS NULL),
      'artist_style_edges', (${membershipCountSql(s)}),
      'artist_release_group_edges', (SELECT count(*) FROM ${s}.release_group_artist)
    )
  )::text`;
}

export function fullCatalogSourcesSql(schema: string): string {
  const s = quoteSchema(schema);
  return `SELECT COALESCE(json_agg(json_build_object(
    'source', source_name,
    'snapshot_id', snapshot_id,
    'license_partition', license_partition
  ) ORDER BY source_name, snapshot_id), '[]'::json)::text
  FROM ${s}.source_snapshot WHERE status IN ('validated', 'published')`;
}

export function buildFullCatalogOverview(
  styles: readonly StyleSummary[],
  relations: readonly RelationDetail[],
  generationId: string,
): UniverseOverview {
  const sorted = [...styles].sort((left, right) => left.entity_id.localeCompare(right.entity_id, "en-US"));
  const rockIndex = sorted.findIndex((style) => style.entity_id === "mw:style:rock");
  if (rockIndex > 0) sorted.unshift(sorted.splice(rockIndex, 1)[0]!);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const layout: Record<string, { x: number; y: number; z: number }> = {};
  sorted.forEach((style, index) => {
    if (index === 0 && style.entity_id === "mw:style:rock") {
      layout[style.entity_id] = { x: 0, y: 0, z: 0 };
      return;
    }
    const random = seededRandom(hashString(`${generationId}:${style.entity_id}:global-v1`));
    const progress = Math.sqrt((index + 1) / Math.max(1, sorted.length));
    const angle = index * goldenAngle + (random() - 0.5) * 0.18;
    const radius = 0.26 + progress * 0.74;
    layout[style.entity_id] = {
      x: round(Math.cos(angle) * radius * 5.94),
      y: round(Math.sin(angle) * radius * 2.05),
      z: round((random() - 0.5) * 0.82),
    };
  });
  const overviewRelations = [...relations]
    .sort((left, right) =>
      relationOverviewRank(left) - relationOverviewRank(right) ||
      left.entity_id.localeCompare(right.entity_id, "en-US")
    )
    .slice(0, FULL_OVERVIEW_RELATION_LIMIT);
  return { styles: sorted, relations: overviewRelations, layout };
}

export function relationOverviewRank(relation: RelationDetail): number {
  const assertionKind = relation.assertion_kind;
  const assertionRank = assertionKind === "fact" ? 0 : assertionKind === "inferred" ? 10 : 20;
  const relationRank = ["evolves_into", "fusion_of", "influences", "subgenre_of", "backlash_against"]
    .includes(relation.relation_type) ? 0 : 2;
  return assertionRank + relationRank;
}

// Preserve reviewed scope, dates, provenance and licensing in the Graph projection.
function relationAssertionSql(schema: string): string {
  return `json_build_object(
    'assertion_id', accepted.assertion_id, 'relation_id', relation.relation_id,
    'claim_key', accepted.claim_key, 'relation_type', relation.relation_kind,
    'direction', relation.direction, 'participants', participants.value,
    'assertion_kind', accepted.assertion_kind, 'stance', accepted.stance,
    'review_status', accepted.review_status, 'metadata_completeness', accepted.metadata_completeness,
    'claim_scope', json_build_object('geographies', accepted.claim_geographies, 'contexts', accepted.claim_contexts),
    'time_context', CASE WHEN accepted.time_precision IS NULL THEN NULL ELSE json_build_object(
      'start', accepted.time_start, 'end', accepted.time_end, 'precision', accepted.time_precision) END,
    'confidence_band', accepted.confidence_band,
    'evidence_ids', COALESCE((SELECT json_agg(link.evidence_id ORDER BY link.evidence_id)
      FROM ${schema}.style_relation_assertion_evidence_v2 link
      WHERE link.assertion_id = accepted.assertion_id), '[]'::json),
    'source_datasets', accepted.source_datasets, 'snapshot_version', accepted.snapshot_version,
    'pipeline_version', accepted.pipeline_version, 'license_partition', accepted.license_partition
  )`;
}

function artistStyleMembershipSql(schema: string): string {
  return `
SELECT membership.artist_id, membership.style_id
FROM (
  SELECT artist_id, style_id FROM ${schema}.artist_style_assertion
  WHERE confidence_status IN ('observed', 'inferred')
  UNION
  SELECT artist_id, style_id FROM ${schema}.artist_style_qualification
  WHERE confidence_status = 'derived'
) membership
JOIN ${schema}.style style ON style.internal_id = membership.style_id
WHERE style.inclusion_status = 'accepted' AND style.retired_at IS NULL`;
}

function membershipCountSql(schema: string): string {
  return `SELECT count(*) FROM (SELECT DISTINCT artist_id, style_id FROM (${artistStyleMembershipSql(schema)}) membership) distinct_membership`;
}

function searchSql(schema: string, table: string, entityType: string, filter: string): string {
  return `
WITH entities AS (
  SELECT internal_id AS entity_id, canonical_name AS name,
    lower(regexp_replace(normalize(canonical_name, NFKC), E'\\s+', ' ', 'g')) AS normalized_name
  FROM ${schema}.${table} WHERE ${filter}
), search_keys AS (
  SELECT entity_id, name, normalized_name, 'exact:' || normalized_name AS search_key FROM entities
  UNION
  SELECT entity_id, name, normalized_name,
    'prefix:' || left(normalized_name, prefix_length) AS search_key
  FROM entities CROSS JOIN LATERAL generate_series(1, char_length(normalized_name)) prefix_length
  UNION
  SELECT entity_id, name, normalized_name,
    'gram:' || substr(replace(normalized_name, ' ', ''), gram_position,
      CASE WHEN char_length(replace(normalized_name, ' ', '')) >= 3 THEN 3 ELSE 2 END) AS search_key
  FROM entities CROSS JOIN LATERAL generate_series(
    1,
    greatest(1, char_length(replace(normalized_name, ' ', '')) -
      CASE WHEN char_length(replace(normalized_name, ' ', '')) >= 3 THEN 3 ELSE 2 END + 1)
  ) gram_position
), distinct_keys AS (
  SELECT DISTINCT search_key, entity_id, name, normalized_name FROM search_keys
  WHERE search_key !~ ':$'
), ranked AS (
  SELECT *, row_number() OVER (PARTITION BY search_key ORDER BY normalized_name, entity_id) AS rank,
    count(*) OVER (PARTITION BY search_key) AS total_count
  FROM distinct_keys
)
SELECT json_build_object(
  'id', search_key,
  'record', json_build_object(
    'entity_type', '${entityType}',
    'results', json_agg(json_build_object('entity_id', entity_id, 'name', name) ORDER BY normalized_name, entity_id),
    'total_count', max(total_count),
    'truncated', max(total_count) > 100
  )
)::text
FROM ranked WHERE rank <= 100
GROUP BY search_key ORDER BY search_key`;
}

function quoteSchema(schema: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(schema)) throw new Error(`Invalid canonical schema ${schema}`);
  return `"${schema}"`;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function hashString(value: string): number {
  const digest = createHash("sha256").update(value).digest();
  return digest.readUInt32BE(0);
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
