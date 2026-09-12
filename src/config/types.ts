import type { ActivityId, CategoryId, CanonicalLocation } from '../core/types.js';

/** Weights for the deterministic ranking function. Must sum to 1. */
export interface ScoringWeights {
  activity: number;
  time: number;
  location: number;
  tag: number;
  quality: number;
}

/** Similarity values for taxonomy relationships. All in [0, 1]. */
export interface ActivitySimilarityConfig {
  /** treadmill -> treadmill */
  exact: number;
  /** treadmill -> workout (child to parent) */
  parent: number;
  /** workout -> treadmill (parent to child) */
  child: number;
  /** treadmill -> running (siblings under the same parent) */
  sibling: number;
  /**
   * Explicit curated cross-link via `ActivityNode.relatedIds`, e.g.
   * running <-> treadmill. A hand-authored link is a stronger signal than a
   * mere shared parent, so this should sit above `sibling`.
   */
  related: number;
  /** basketball -> coding when both sit under the same top-level category */
  sameCategory: number;
  /** painting -> treadmill */
  unrelated: number;
}

export interface LocationCompatibilityConfig {
  /** Distance bands in metres, ascending. Score applies at or below the radius. */
  bands: Array<{ maxMeters: number; score: number }>;
  /** Applied when two locations share a campus but exceed every band. */
  sameCampus: number;
  /** Applied when nothing relates the locations. */
  far: number;
  /** Candidates scoring below this are hard-filtered out. */
  minAcceptable: number;
}

export interface TimeCompatibilityConfig {
  /** Start-time delta at or below which compatibility is 1.0. */
  perfectToleranceMinutes: number;
  /** Start-time delta beyond which compatibility is 0. */
  maxToleranceMinutes: number;
  /** Weight of interval overlap vs. start-time proximity. */
  overlapWeight: number;
  /** Candidates scoring below this are hard-filtered out. */
  minAcceptable: number;
}

export interface CacheTtlConfig {
  /** Semantic interpretations change slowly. */
  semanticMs: number;
  /** Real-time recommendations: seconds to tens of seconds. */
  recommendationMs: number;
  /** Personalized activity suggestions. */
  suggestionsMs: number;
  /** Bucket width used to keep exact timestamps out of recommendation keys. */
  recommendationTimeBucketMs: number;
}

export interface AlgorithmConfig {
  weights: ScoringWeights;
  /** A candidate must reach this score before the user is joined to it. */
  matchThreshold: number;
  activitySimilarity: ActivitySimilarityConfig;
  location: LocationCompatibilityConfig;
  time: TimeCompatibilityConfig;
  cache: CacheTtlConfig;

  /** Stage-1 retrieval bound. Detailed scoring never sees more than this. */
  candidateLimit: number;
  /** Events returned by the real-time recommendation path. */
  recommendationLimit: number;

  /** Default duration per activity, in minutes. */
  activityDurationsMinutes: Record<ActivityId, number>;
  /** Used when neither the user nor the taxonomy supplies a duration. */
  defaultDurationMinutes: number;

  /** How far ahead candidate retrieval looks when scanning for overlap. */
  retrievalWindowMinutes: number;
  /** Lifetime of a newly created event's matching window. */
  defaultEventTtlMinutes: number;
  /** Capacity for events this engine creates. */
  defaultEventCapacity: number;

  /**
   * Fallback when no explicit time, no relative phrase, and no availability
   * data exist: start this many minutes from now.
   */
  fallbackStartOffsetMinutes: number;

  /** Below this LLM confidence the interpretation is treated as unusable. */
  minSemanticConfidence: number;

  /** Suggestion diversity: max suggestions drawn from one category. */
  maxSuggestionsPerCategory: number;
  suggestionLimit: number;
}

/** One node in the controlled activity vocabulary. */
export interface ActivityNode {
  id: ActivityId;
  categoryId: CategoryId;
  /** Structural parent inside the category, e.g. treadmill -> workout. */
  parentId?: ActivityId;
  /** Canonical tags attached to this activity. */
  tags: string[];
  /** Explicit cross-links where the tree does not capture the relationship. */
  relatedIds?: ActivityId[];
}

export interface TaxonomyConfig {
  categories: Array<{ id: CategoryId; name: string }>;
  activities: ActivityNode[];
  /** Alias -> canonical activity id. Keys must already be normalized. */
  synonyms: Record<string, ActivityId>;
}

export interface LocationConfig {
  locations: CanonicalLocation[];
}
