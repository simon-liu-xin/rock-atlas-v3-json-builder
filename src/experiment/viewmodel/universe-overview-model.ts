import type { ExperimentSample } from "./candidate-model.ts";
import type {
  AssertionRecordV1,
  StyleRelationAssertionV2,
} from "../../generated/schema-types.ts";
import { adaptExperimentRelationsToV2 } from "./style-relation-v2-adapter.ts";

export type UniverseAssertionKind = AssertionRecordV1["assertion_kind"];

export interface UniversePoint {
  x: number;
  y: number;
  z: number;
}

export interface UniverseStyle {
  internal_id: string;
  canonical_name: string;
  era: string;
  region: string;
  artist_ids: string[];
  representative_artist_ids: string[];
  source_url: string;
  path_id: string | null;
}

export interface UniverseArtist {
  internal_id: string;
  canonical_name: string;
  style_id: string;
  source_url: string;
}

export interface UniverseReleaseGroup {
  internal_id: string;
  canonical_name: string;
  artist_ids: string[];
  primary_type: string;
  secondary_types: string[];
  first_release_date: string | null;
  source_url: string;
}

export interface UniverseRelation {
  internal_id: string;
  source_id: string;
  target_id: string;
  source_name: string;
  target_name: string;
  relation_type: string;
  direction: string;
  assertion_kind: UniverseAssertionKind;
  label: string;
  summary: string;
  score: number | null;
  coverage_state: string;
  evidence_ids: string[];
  related_style_ids?: string[];
}

export interface UniverseOverviewViewModel {
  snapshot_id: string;
  counts: {
    styles: number;
    artists: number;
    release_groups: number;
    relations: number;
  };
  styles: UniverseStyle[];
  artists: UniverseArtist[];
  release_groups: UniverseReleaseGroup[];
  relations: UniverseRelation[];
  style_relations_v2: StyleRelationAssertionV2[];
  eras: string[];
  regions: string[];
  relation_types: string[];
  layout: {
    style_positions: Record<string, UniversePoint>;
    artist_positions: Record<string, UniversePoint>;
    particle_seed: number;
  };
}

export function buildUniverseOverviewViewModel(
  sample: ExperimentSample,
): UniverseOverviewViewModel {
  const rawStyles = new Map(sample.styles.map((style) => [style.internal_id, style]));
  const rawArtists = new Map(sample.artists.map((artist) => [artist.internal_id, artist]));
  const pathByStyle = new Map(
    sample.paths.map((path) => [path.question.focus_id, path.path_id]),
  );

  const styles = sample.styles.map((style): UniverseStyle => {
    for (const artistId of style.artist_ids) {
      if (!rawArtists.has(artistId)) {
        throw new Error(`Universe style ${style.internal_id} references missing artist ${artistId}.`);
      }
    }
    return {
      internal_id: style.internal_id,
      canonical_name: style.canonical_name,
      era: style.era,
      region: style.region,
      artist_ids: [...style.artist_ids],
      representative_artist_ids: style.artist_ids.slice(0, 2),
      source_url: safeExternalUrl(style.source_url),
      path_id: pathByStyle.get(style.internal_id) ?? null,
    };
  });

  const artists = sample.artists.map((artist): UniverseArtist => {
    if (!rawStyles.has(artist.style_id)) {
      throw new Error(`Universe artist ${artist.internal_id} references missing style ${artist.style_id}.`);
    }
    return {
      internal_id: artist.internal_id,
      canonical_name: artist.canonical_name,
      style_id: artist.style_id,
      source_url: safeExternalUrl(artist.source_url),
    };
  });

  const releaseGroups = sample.release_groups.map((releaseGroup): UniverseReleaseGroup => {
    for (const artistId of releaseGroup.artist_ids) {
      if (!rawArtists.has(artistId)) {
        throw new Error(
          `Universe release group ${releaseGroup.internal_id} references missing artist ${artistId}.`,
        );
      }
    }
    return {
      internal_id: releaseGroup.internal_id,
      canonical_name: releaseGroup.canonical_name,
      artist_ids: [...releaseGroup.artist_ids],
      primary_type: releaseGroup.primary_type,
      secondary_types: [...releaseGroup.secondary_types],
      first_release_date: releaseGroup.first_release_date,
      source_url: safeExternalUrl(releaseGroup.source_url),
    };
  });

  const relations = sample.relations.map((relation): UniverseRelation => {
    const source = rawStyles.get(relation.source_id);
    const target = rawStyles.get(relation.target_id);
    if (!source || !target) {
      throw new Error(
        `Universe relation ${relation.internal_id} has unresolved style endpoints.`,
      );
    }
    return {
      internal_id: relation.internal_id,
      source_id: relation.source_id,
      target_id: relation.target_id,
      source_name: source.canonical_name,
      target_name: target.canonical_name,
      relation_type: relation.relation_type,
      direction: relation.direction,
      assertion_kind: normalizeUniverseAssertionKind(relation.assertion_kind),
      label: relation.label,
      summary: relation.summary,
      score: relation.score,
      coverage_state: relation.coverage_state,
      evidence_ids: [...relation.evidence_ids],
    };
  });
  const styleRelationsV2 = sample.style_relations_v2
    ? sample.style_relations_v2.map((assertion) => structuredClone(assertion))
    : adaptExperimentRelationsToV2(sample);

  const stylePositions = buildStylePositions(styles, styleRelationsV2, sample.snapshot_id);
  const artistPositions = buildArtistPositions(artists, stylePositions, sample.snapshot_id);

  return {
    snapshot_id: sample.snapshot_id,
    counts: {
      styles: styles.length,
      artists: artists.length,
      release_groups: releaseGroups.length,
      relations: new Set(styleRelationsV2.map((relation) => relation.relation_id)).size,
    },
    styles,
    artists,
    release_groups: releaseGroups,
    relations,
    style_relations_v2: styleRelationsV2,
    eras: uniqueInOrder(styles.map((style) => style.era)),
    regions: uniqueInOrder(styles.map((style) => style.region)),
    relation_types: uniqueInOrder(relations.map((relation) => relation.relation_type)),
    layout: {
      style_positions: stylePositions,
      artist_positions: artistPositions,
      particle_seed: hashString(sample.snapshot_id),
    },
  };
}

function normalizeUniverseAssertionKind(value: unknown): UniverseAssertionKind {
  if (value === "fact" || value === "inferred" || value === "candidate") return value;
  throw new Error(`Unsupported assertion kind in universe relation: ${String(value)}.`);
}

function buildStylePositions(
  styles: UniverseStyle[],
  relations: StyleRelationAssertionV2[],
  snapshotId: string,
): Record<string, UniversePoint> {
  if (styles.length > 200) return buildLargeCatalogStylePositions(styles, relations, snapshotId);

  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const positions = new Map<string, UniversePoint>();
  const sorted = [...styles].sort((left, right) =>
    left.internal_id.localeCompare(right.internal_id),
  );
  const rockIndex = sorted.findIndex((style) => style.internal_id === "mw:style:rock");
  if (rockIndex > 0) {
    const [rock] = sorted.splice(rockIndex, 1);
    if (rock) sorted.unshift(rock);
  }

  sorted.forEach((style, index) => {
    if (index === 0 && style.internal_id === "mw:style:rock") {
      positions.set(style.internal_id, { x: 0, y: 0, z: 0 });
      return;
    }
    const random = seededRandom(hashString(`${snapshotId}:${style.internal_id}`));
    const angle = index * goldenAngle + (random() - 0.5) * 0.22;
    const radius = 0.82 + Math.sqrt(index) * 0.66;
    positions.set(style.internal_id, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius * 0.64,
      z: (random() - 0.5) * 0.5,
    });
  });

  for (let iteration = 0; iteration < 72; iteration += 1) {
    const forces = new Map(sorted.map((style) => [style.internal_id, { x: 0, y: 0 }]));
    for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex += 1) {
        const left = positions.get(sorted[leftIndex]!.internal_id)!;
        const right = positions.get(sorted[rightIndex]!.internal_id)!;
        const dx = right.x - left.x;
        const dy = right.y - left.y;
        const distanceSquared = Math.max(0.16, dx * dx + dy * dy);
        const force = 0.018 / distanceSquared;
        const leftForce = forces.get(sorted[leftIndex]!.internal_id)!;
        const rightForce = forces.get(sorted[rightIndex]!.internal_id)!;
        leftForce.x -= dx * force;
        leftForce.y -= dy * force;
        rightForce.x += dx * force;
        rightForce.y += dy * force;
      }
    }
    for (const [sourceId, targetId] of relationAttractionPairs(relations)) {
      const source = positions.get(sourceId)!;
      const target = positions.get(targetId)!;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.max(0.01, Math.hypot(dx, dy));
      const spring = (distance - 1.35) * 0.012;
      const sourceForce = forces.get(sourceId)!;
      const targetForce = forces.get(targetId)!;
      sourceForce.x += (dx / distance) * spring;
      sourceForce.y += (dy / distance) * spring;
      targetForce.x -= (dx / distance) * spring;
      targetForce.y -= (dy / distance) * spring;
    }
    for (const style of sorted) {
      if (style.internal_id === "mw:style:rock") continue;
      const position = positions.get(style.internal_id)!;
      const force = forces.get(style.internal_id)!;
      position.x += force.x - position.x * 0.0015;
      position.y += force.y - position.y * 0.0015;
    }
  }

  const xExtent = Math.max(1, ...[...positions.values()].map((point) => Math.abs(point.x)));
  const yExtent = Math.max(1, ...[...positions.values()].map((point) => Math.abs(point.y)));
  return Object.fromEntries(
    styles.map((style) => {
      const point = positions.get(style.internal_id)!;
      return [style.internal_id, {
        x: round((point.x / xExtent) * 3.45),
        y: round((point.y / yExtent) * 2.05),
        z: round(point.z),
      }];
    }),
  );
}

function buildLargeCatalogStylePositions(
  styles: UniverseStyle[],
  relations: StyleRelationAssertionV2[],
  snapshotId: string,
): Record<string, UniversePoint> {
  const generatedStyles = styles
    .filter((style) => isExtendedCatalogStyle(style.internal_id))
    .sort((left, right) => left.internal_id.localeCompare(right.internal_id));
  const sourcedStyles = styles.filter((style) => !isExtendedCatalogStyle(style.internal_id));
  const sourcedStyleIds = new Set(sourcedStyles.map((style) => style.internal_id));
  const sourcedRelations = relations.filter((relation) =>
    relation.participants.every((participant) => sourcedStyleIds.has(participant.style_id))
  );
  const positions: Record<string, UniversePoint> = buildStylePositions(
    sourcedStyles,
    sourcedRelations,
    snapshotId,
  );
  for (const point of Object.values(positions)) {
    point.x = round(point.x * 1.72);
  }
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  generatedStyles.forEach((style, index) => {
    const random = seededRandom(hashString(`${snapshotId}:${style.internal_id}:global`));
    const progress = Math.sqrt((index + 1) / Math.max(1, generatedStyles.length));
    const angle = index * goldenAngle + (random() - 0.5) * 0.18;
    const radius = 0.26 + progress * 0.74;
    positions[style.internal_id] = {
      x: round(Math.cos(angle) * radius * 5.94),
      y: round(Math.sin(angle) * radius * 2.05),
      z: round((random() - 0.5) * 0.82),
    };
  });

  return Object.fromEntries(styles.map((style) => [style.internal_id, positions[style.internal_id]!]));
}

function isExtendedCatalogStyle(styleId: string): boolean {
  return styleId.startsWith("mw:style:wikidata:") || styleId.startsWith("mw:mock:style:");
}

function relationAttractionPairs(
  relations: readonly StyleRelationAssertionV2[],
): Array<[string, string]> {
  return relations.flatMap((relation): Array<[string, string]> => {
    if (relation.relation_type === "unrelated_within_scope") return [];
    const sources = relation.participants
      .filter((participant) => participant.role === "source")
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((participant) => participant.style_id);
    const targets = relation.participants
      .filter((participant) => participant.role === "target")
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((participant) => participant.style_id);
    const peers = relation.participants
      .filter((participant) => participant.role === "peer")
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((participant) => participant.style_id);

    if (relation.direction === "undirected") return [[peers[0]!, peers[1]!]];
    return sources.flatMap((sourceId) =>
      targets.map((targetId): [string, string] => [sourceId, targetId])
    );
  });
}

function buildArtistPositions(
  artists: UniverseArtist[],
  stylePositions: Record<string, UniversePoint>,
  snapshotId: string,
): Record<string, UniversePoint> {
  return Object.fromEntries(
    artists.map((artist) => {
      const parent = stylePositions[artist.style_id];
      if (!parent) throw new Error(`Universe artist ${artist.internal_id} has no layout parent.`);
      const random = seededRandom(hashString(`${snapshotId}:${artist.internal_id}`));
      const angle = random() * Math.PI * 2;
      const radius = 0.2 + Math.pow(random(), 0.62) * 0.46;
      return [artist.internal_id, {
        x: round(parent.x + Math.cos(angle) * radius),
        y: round(parent.y + Math.sin(angle) * radius * 0.58),
        z: round(parent.z + (random() - 0.5) * 0.32),
      }];
    }),
  );
}

function safeExternalUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname && !url.username && !url.password) {
      return url.toString();
    }
  } catch {
    // The common failure below keeps the overview boundary explicit.
  }
  throw new Error(`Unsafe external URL in universe data: ${value}`);
}

function uniqueInOrder(values: string[]): string[] {
  return [...new Set(values)];
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
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
