import type { AlgorithmConfig } from './types.js';

/**
 * Every number here is a tuning knob, not a law. Callers override any subset
 * via `createMatchingEngine({ config })`.
 */
export const DEFAULT_CONFIG: AlgorithmConfig = {
  // Spec-recommended initial weighting.
  weights: {
    activity: 0.40,
    time: 0.25,
    location: 0.20,
    tag: 0.10,
    quality: 0.05,
  },

  matchThreshold: 0.70,

  activitySimilarity: {
    exact: 1.0,
    parent: 0.8,
    child: 0.7,
    sibling: 0.6,
    related: 0.7,
    sameCategory: 0.35,
    unrelated: 0.0,
  },

  location: {
    bands: [
      { maxMeters: 0, score: 1.0 },
      { maxMeters: 250, score: 0.9 },
      { maxMeters: 800, score: 0.7 },
    ],
    sameCampus: 0.5,
    far: 0.0,
    minAcceptable: 0.0,
  },

  time: {
    perfectToleranceMinutes: 5,
    maxToleranceMinutes: 90,
    overlapWeight: 0.5,
    minAcceptable: 0.05,
  },

  cache: {
    semanticMs: 7 * 24 * 60 * 60 * 1000, // 7 days — semantics change slowly
    recommendationMs: 15 * 1000,          // stale is acceptable; core path revalidates
    suggestionsMs: 5 * 60 * 1000,
    recommendationTimeBucketMs: 5 * 60 * 1000,
  },

  candidateLimit: 100,
  recommendationLimit: 10,

  activityDurationsMinutes: {
    walking: 30,
    coffee: 45,
    lunch: 60,
    workout: 60,
    treadmill: 45,
    running: 45,
    basketball: 90,
    coding: 90,
    programming: 90,
    robotics: 120,
    drawing: 60,
    painting: 90,
    photography: 60,
    studying: 90,
    homework: 90,
  },
  defaultDurationMinutes: 60,

  retrievalWindowMinutes: 180,
  defaultEventTtlMinutes: 120,
  defaultEventCapacity: 6,

  fallbackStartOffsetMinutes: 15,

  minSemanticConfidence: 0.4,

  maxSuggestionsPerCategory: 2,
  suggestionLimit: 6,
};

/** Merge a partial override onto the defaults, one nested level deep. */
export function resolveConfig(overrides?: DeepPartial<AlgorithmConfig>): AlgorithmConfig {
  if (!overrides) return DEFAULT_CONFIG;
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    weights: { ...DEFAULT_CONFIG.weights, ...overrides.weights },
    activitySimilarity: {
      ...DEFAULT_CONFIG.activitySimilarity,
      ...overrides.activitySimilarity,
    },
    location: {
      ...DEFAULT_CONFIG.location,
      ...overrides.location,
      bands: overrides.location?.bands
        ? (overrides.location.bands as AlgorithmConfig['location']['bands'])
        : DEFAULT_CONFIG.location.bands,
    },
    time: { ...DEFAULT_CONFIG.time, ...overrides.time },
    cache: { ...DEFAULT_CONFIG.cache, ...overrides.cache },
    activityDurationsMinutes: {
      ...DEFAULT_CONFIG.activityDurationsMinutes,
      ...overrides.activityDurationsMinutes,
    },
  } as AlgorithmConfig;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};
