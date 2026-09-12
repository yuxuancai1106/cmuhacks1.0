import type {
  LocationService,
  MatchableEvent,
  NormalizedIntent,
  ScoredEvent,
  TaxonomyIndex,
} from '../core/types.js';
import type { AlgorithmConfig, ScoringWeights } from '../config/types.js';
import { activityScore } from './activity.js';
import { tagScore } from './tags.js';
import { timeScore } from './time.js';
import { qualityScore } from './quality.js';
import { locationCompatibility } from './location.js';

export interface RankerDeps {
  taxonomy: TaxonomyIndex;
  locations: LocationService;
  config: AlgorithmConfig;
}

const WEIGHT_SUM_TOLERANCE = 1e-6;

/**
 * Validates that `ScoringWeights` sums to 1 (within floating-point
 * tolerance), so a misconfigured engine fails loudly instead of silently
 * producing scores that don't mean what callers assume.
 *
 * Deliberately NOT called from `rankCandidates`: this scorer is the hot
 * path for every recommendation request and must stay pure/cheap, and
 * `AlgorithmConfig` is static for the engine's lifetime, so re-validating
 * it on every call would be wasted work. Export this for the engine
 * construction site to call once (e.g. inside `createMatchingEngine` /
 * wherever `AlgorithmConfig` is finalized) rather than per request.
 */
export function assertWeightsSumToOne(w: ScoringWeights): void {
  const sum = w.activity + w.time + w.location + w.tag + w.quality;
  if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
    throw new Error(`ScoringWeights must sum to 1, got ${sum}`);
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Computes the five deterministic sub-scores and combines them via the
 * configured weights. No LLM, no I/O, no `Date.now()` — `now` is always
 * caller-supplied.
 */
export function scoreEvent(
  intent: NormalizedIntent,
  event: MatchableEvent,
  deps: RankerDeps,
  now: Date,
): ScoredEvent {
  const { taxonomy, locations, config } = deps;

  const activity = activityScore(intent, event, taxonomy, config);
  const time = timeScore(intent, event, config, now);
  const location = locationCompatibility(intent.locationIds, event.locationId, locations, config);
  const tag = tagScore(intent.tags, event.tags);
  const quality = qualityScore(event, now);

  const { weights } = config;
  const score = clamp01(
    weights.activity * activity +
      weights.time * time +
      weights.location * location +
      weights.tag * tag +
      weights.quality * quality,
  );

  return {
    event,
    score,
    breakdown: { activity, time, location, tag, quality },
  };
}

/**
 * Scores every candidate and sorts descending, with a fully deterministic
 * tie-break: equal score -> earlier `createdAt` wins -> then
 * lexicographically smaller `event.id`. Two runs over the same input always
 * produce the identical order, which matters because exact score ties are
 * common (many candidates can land on the same coarse breakdown) and
 * callers (pagination, tests, idempotent replay) depend on stable results.
 *
 * Builds a new array via `map` before sorting, so the caller's `events`
 * array is never mutated.
 */
export function rankCandidates(
  intent: NormalizedIntent,
  events: MatchableEvent[],
  deps: RankerDeps,
  now: Date,
): ScoredEvent[] {
  return events
    .map((event) => scoreEvent(intent, event, deps, now))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const createdAtDiffMs = a.event.createdAt.getTime() - b.event.createdAt.getTime();
      if (createdAtDiffMs !== 0) return createdAtDiffMs;
      if (a.event.id < b.event.id) return -1;
      if (a.event.id > b.event.id) return 1;
      return 0;
    });
}
