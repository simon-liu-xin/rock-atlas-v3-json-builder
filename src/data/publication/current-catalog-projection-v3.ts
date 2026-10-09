import { normalizeSearchTextV1 } from '../contracts/catalog-v3.ts';
import type { ArtistSummary, ReleaseGroupSummary, RelationDetail, StyleSummary, UniverseOverview } from '../catalog/catalog-repository.ts';
import type { ExperimentSample } from '../../experiment/viewmodel/candidate-model.ts';
import { buildUniverseOverviewViewModel } from '../../experiment/viewmodel/universe-overview-model.ts';
import type { StyleRelationAssertionV2 } from '../../generated/schema-types.ts';
import { FULL_FRONTEND_NAMESPACES } from './catalog-full-projection-v3.ts';

interface CanonicalEntity {
  internal_id: string;
  canonical_name: string;
  source_url: string;
  description?: string;
}
export interface CurrentCanonicalCatalog {
  schema_version: '2.0';
  generation_id: string;
  generated_at: string;
  preserved_seed_artist_count: number;
  styles: (CanonicalEntity & { wikidata_qid: string; inclusion_status: string; origin_date_text: string | null; region_text: string | null })[];
  artists: (CanonicalEntity & { artist_type?: string | null; musicbrainz_mbid?: string | null; wikidata_qid?: string | null })[];
  release_groups: (CanonicalEntity & { artist_ids: string[]; primary_type: string; secondary_types: string[]; first_release_date_text: string | null; cover_art_url: string | null })[];
  representative_artists: { style_id: string; artist_id: string; asserted_style_id: string; selection_basis: string }[];
  style_relations_v2: StyleRelationAssertionV2[];
  catalog_evidence: { evidence_id: string; [key: string]: unknown }[];
  source_snapshots: { source_name: string; snapshot_id: string; license_partition: string; redistributable: boolean }[];
}

// A migration of the existing SQL-exported corpus, not a new full-source acquisition.
export function projectCurrentCatalogV3(canonical: CurrentCanonicalCatalog, published: ExperimentSample, seed: ExperimentSample) {
  if (canonical.schema_version !== '2.0' || published.snapshot_id !== canonical.generation_id) {
    throw new Error('Current canonical and SQL-exported generations do not match');
  }
  const namespaces: Record<string, Record<string, unknown>> = Object.fromEntries(FULL_FRONTEND_NAMESPACES.map((name) => [name, {}]));
  const styleRecords = new Map<string, StyleSummary>();
  const publishedStyles = new Map(published.styles.map((style) => [style.internal_id, style]));
  const membership = new Map<string, Set<string>>();
  const styleIdsByArtist = new Map<string, Set<string>>();
  const presentationIdsByArtist = new Map<string, Set<string>>();
  const knownArtists = new Set(canonical.artists.map((artist) => artist.internal_id));
  if (canonical.preserved_seed_artist_count !== seed.artists.length ||
      seed.artists.some((artist) => !knownArtists.has(artist.internal_id))) {
    throw new Error('The audited corpus must preserve every original seed artist');
  }
  for (const style of canonical.styles.filter((row) => row.inclusion_status === 'accepted')) {
    const display = publishedStyles.get(style.internal_id);
    styleRecords.set(style.internal_id, {
      entity_id: style.internal_id, name: style.canonical_name, description: style.description ?? null,
      era: display?.era ?? style.origin_date_text, region: display?.region ?? style.region_text,
      source_url: style.source_url, artist_count: 0,
      path_id: seed.paths.find((path) => path.question.focus_id === style.internal_id)?.path_id ?? null,
    });
    membership.set(style.internal_id, new Set());
  }
  function associate(styleId: string, artistId: string, assertedStyleId: string) {
    if (!membership.has(styleId) || !knownArtists.has(artistId)) throw new Error('Unresolved Artist/Style membership');
    membership.get(styleId)!.add(artistId);
    const presented = presentationIdsByArtist.get(artistId) ?? new Set<string>();
    presented.add(styleId); presentationIdsByArtist.set(artistId, presented);
    const asserted = styleIdsByArtist.get(artistId) ?? new Set<string>();
    if (styleRecords.has(assertedStyleId)) asserted.add(assertedStyleId);
    styleIdsByArtist.set(artistId, asserted);
  }
  for (const row of canonical.representative_artists) associate(row.style_id, row.artist_id, row.asserted_style_id);
  for (const artist of seed.artists) {
    associate(artist.style_id, artist.internal_id, artist.style_id);
  }
  const artists = canonical.artists.map((artist): ArtistSummary => ({
    entity_id: artist.internal_id, name: artist.canonical_name, source_url: artist.source_url,
    description: artist.description ?? null, artist_type: artist.artist_type ?? null,
    style_ids: [...(styleIdsByArtist.get(artist.internal_id) ?? [])].sort(),
    presentation_style_ids: [...(presentationIdsByArtist.get(artist.internal_id) ?? [])].sort(),
  }));
  const artistById = new Map(artists.map((artist) => [artist.entity_id, artist]));
  const releases = canonical.release_groups.map((release): ReleaseGroupSummary => {
    if (release.artist_ids.some((id) => !knownArtists.has(id))) throw new Error('Unresolved ReleaseGroup credit');
    return { entity_id: release.internal_id, name: release.canonical_name, artist_ids: release.artist_ids,
      primary_type: release.primary_type, secondary_types: release.secondary_types,
      first_release_date: release.first_release_date_text, source_url: release.source_url,
      description: release.description ?? null, cover_art_url: release.cover_art_url };
  });
  const legacyRelations = new Map(published.relations.map((relation) => [relation.internal_id, relation]));
  const relations = canonical.style_relations_v2.filter((row) => row.stance === 'supports' && row.review_status === 'accepted')
    .map((row): RelationDetail => ({ entity_id: row.relation_id, relation_type: row.relation_type, direction: row.direction,
      participants: row.participants, assertion_kind: row.assertion_kind, confidence_band: row.confidence_band,
      evidence_ids: row.evidence_ids, source_datasets: row.source_datasets,
      ...(legacyRelations.has(row.relation_id) ? {
        label: legacyRelations.get(row.relation_id)!.label,
        summary: legacyRelations.get(row.relation_id)!.summary,
      } : {}),
      assertion: row,
    }));
  for (const artist of artists) namespaces['artist-summary']![artist.entity_id] = artist;
  for (const release of releases) namespaces['release-group-summary']![release.entity_id] = release;
  for (const relation of relations) {
    if (relation.participants.some((p) => !styleRecords.has(p.style_id))) throw new Error('Unresolved relation endpoint');
    namespaces.relation![relation.entity_id] = relation;
  }
  for (const evidence of canonical.catalog_evidence) namespaces.evidence![evidence.evidence_id] = evidence;
  function pages(namespace: string, id: string, items: unknown[], pageSize: number) {
    for (let offset = 0; offset < Math.max(1, items.length); offset += pageSize) {
      namespaces[namespace]![`${id}:page:${offset / pageSize}`] = {
        items: items.slice(offset, offset + pageSize), next_offset: offset + pageSize < items.length ? offset + pageSize : null,
      };
    }
  }
  for (const [id, style] of styleRecords) {
    const members = [...membership.get(id)!].map((artistId) => artistById.get(artistId)!)
      .sort((a, b) => a.name.localeCompare(b.name, 'en-US') || a.entity_id.localeCompare(b.entity_id, 'en-US'));
    const record = { ...style, artist_count: members.length };
    styleRecords.set(id, record); namespaces['style-summary']![id] = record;
    pages('style-artists', id, members, 60);
    pages('style-relations', id, relations.filter((r) => r.participants.some((p) => p.style_id === id)), 60);
  }
  for (const artist of artists) {
    const items = releases.filter((release) => release.artist_ids.includes(artist.entity_id))
      .sort((a, b) => (a.first_release_date ?? '9999').localeCompare(b.first_release_date ?? '9999') || a.entity_id.localeCompare(b.entity_id));
    pages('artist-release-groups', artist.entity_id, items, 24);
  }
  // Old graph occurrences resolve by explicit canonical IDs already present in the SQL export.
  for (const row of published.artists) if (row.canonical_entity_id && row.canonical_entity_id !== row.internal_id) {
    namespaces['identity-resolution']![row.internal_id] = { status: 'redirected', from_id: row.internal_id, entity_id: row.canonical_entity_id };
  }
  for (const row of published.release_groups) if (row.canonical_entity_id && row.canonical_entity_id !== row.internal_id) {
    namespaces['identity-resolution']![row.internal_id] = { status: 'redirected', from_id: row.internal_id, entity_id: row.canonical_entity_id };
  }
  buildSearch(namespaceEntries([...styleRecords.values()], 'style'), namespaces['search-style']!);
  buildSearch(namespaceEntries(artists, 'artist'), namespaces['search-artist']!);
  buildSearch(namespaceEntries(releases, 'release-group'), namespaces['search-release-group']!);
  const previousLayout = buildUniverseOverviewViewModel(published).layout;
  const overview: UniverseOverview = { styles: [...styleRecords.values()], relations: relations.slice(0, 1500),
    layout: previousLayout.style_positions, particle_seed: previousLayout.particle_seed };
  return { namespaces, overview,
    counts: { canonical: { styles: styleRecords.size, artists: artists.length, release_groups: releases.length, relations: relations.length, evidence: canonical.catalog_evidence.length },
      projections: { preserved_seed_artists: canonical.preserved_seed_artist_count,
        artist_style_edges: [...membership.values()].reduce((n, ids) => n + ids.size, 0),
        overview_styles: styleRecords.size } },
  };
}

function namespaceEntries(entities: readonly { entity_id: string; name: string }[], type: string) {
  return entities.map((entity) => ({ ...entity, entity_type: type }));
}
function buildSearch(entities: { entity_id: string; name: string; entity_type: string }[], target: Record<string, unknown>) {
  const postings = new Map<string, { entity_id: string; name: string }[]>();
  for (const entity of entities) {
    const name = normalizeSearchTextV1(entity.name);
    const compact = name.replaceAll(' ', '');
    const width = compact.length >= 3 ? 3 : Math.max(1, compact.length);
    const keys = new Set([`exact:${name}`, ...Array.from({ length: name.length }, (_, i) => `prefix:${name.slice(0, i + 1)}`),
      ...Array.from({ length: Math.max(1, compact.length - width + 1) }, (_, i) => `gram:${compact.slice(i, i + width)}`)]);
    for (const key of keys) {
      const list = postings.get(key) ?? []; list.push({ entity_id: entity.entity_id, name: entity.name }); postings.set(key, list);
    }
  }
  for (const [key, entries] of postings) {
    entries.sort((a, b) => normalizeSearchTextV1(a.name).localeCompare(normalizeSearchTextV1(b.name), 'en-US') || a.entity_id.localeCompare(b.entity_id));
    target[key] = { entity_type: entities[0]?.entity_type ?? '', results: entries.slice(0, 100), total_count: entries.length, truncated: entries.length > 100 };
  }
}
