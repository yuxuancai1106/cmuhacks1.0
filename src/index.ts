/**
 * Public entry point.
 *
 * Wires the three service paths over the ports in `src/core/types.ts` and
 * re-exports everything an integrator (or a test) needs. Two things happen
 * here exactly once, at construction, rather than per request:
 *
 *  - `assertWeightsSumToOne` — a misconfigured weighting fails loudly at
 *    startup instead of silently producing scores that don't mean what the
 *    threshold assumes.
 *  - `buildTaxonomyIndex` — the compiled vocabulary (parent chains, inherited
 *    tags, related-id closure) is built once and shared by every path.
 *
 * Note what `createRecommendationService` is *not* given: no `llm`, no
 * `parser`. The real-time path physically cannot make an LLM call.
 */
import type {
  AvailabilityService,
  CacheService,
  Clock,
  EventRepository,
  IdempotencyStore,
  LlmClient,
  LocationService,
  MatchOutcome,
  Metrics,
  RawIntent,
  RecommendationResult,
  TaxonomyIndex,
  UserId,
  UserProfileService,
} from './core/types.js';
import type { AlgorithmConfig, TaxonomyConfig } from './config/types.js';
import type { DeepPartial } from './config/defaults.js';
import { resolveConfig } from './config/defaults.js';
import { DEFAULT_TAXONOMY } from './config/taxonomy.js';
import { CMU_LOCATIONS } from './config/locations.js';
import { buildTaxonomyIndex } from './core/taxonomyIndex.js';
import { createLocationService } from './location/service.js';
import { createMemoryCache } from './cache/memory.js';
import { createInMemoryMetrics } from './observability/metrics.js';
import { systemClock } from './adapters/clock.js';
import { createSemanticParser } from './semantic/parser.js';
import { assertWeightsSumToOne } from './scoring/score.js';
import { createRecommendationService } from './services/recommendation.js';
import { createMatchingService } from './services/matching.js';
import { createSuggestionService } from './services/suggestions.js';
import type {
  ActivityPopularitySource,
  ActivitySuggestion,
  SuggestionContext,
} from './services/suggestions.js';

export interface EngineDeps {
  /** The only port with no usable default — the app owns its event storage. */
  events: EventRepository;
  /** Default: `createMemoryCache()` (in-process; swap for Redis in production). */
  cache?: CacheService;
  /** Default: none. The semantic parser then resolves only its deterministic tier. */
  llm?: LlmClient;
  /** Default: none. Time resolution falls back to `now + fallbackStartOffsetMinutes`. */
  availability?: AvailabilityService;
  /** Default: `createLocationService(CMU_LOCATIONS)`. */
  locations?: LocationService;
  /** Default: none. Matching then runs without profile personalization. */
  profiles?: UserProfileService;
  /** Default: none. Without it, `intent.idempotencyKey` has no effect. */
  idempotency?: IdempotencyStore;
  clock?: Clock;
  metrics?: Metrics;
  config?: DeepPartial<AlgorithmConfig>;
  taxonomy?: TaxonomyConfig;
  /**
   * Additive extension to the pinned contract (optional, defaults to none):
   * a pre-aggregated campus-popularity source for `suggestActivities`. Without
   * it, popularity is derived from one bounded open-event sweep per cache miss.
   */
  popularity?: ActivityPopularitySource;
}

export interface MatchingEngine {
  /** Real-time advisory path. Read-only, zero LLM calls, ever. */
  recommend(intent: RawIntent, userId?: UserId): Promise<RecommendationResult>;
  /** Authoritative path. The only path that joins or creates. */
  match(userId: UserId, intent: RawIntent): Promise<MatchOutcome>;
  /** Deterministic personalized suggestions, diversity-constrained. */
  suggestActivities(userId: UserId, ctx?: SuggestionContext): Promise<ActivitySuggestion[]>;
  readonly config: AlgorithmConfig;
  readonly taxonomy: TaxonomyIndex;
  readonly metrics: Metrics;
}

export function createMatchingEngine(deps: EngineDeps): MatchingEngine {
  const config = resolveConfig(deps.config);
  // Once, at construction — `rankCandidates` is the hot path and must stay
  // free of validation work (see the doc comment on this function).
  assertWeightsSumToOne(config.weights);

  const taxonomy = buildTaxonomyIndex(deps.taxonomy ?? DEFAULT_TAXONOMY, config);

  const clock = deps.clock ?? systemClock();
  const metrics = deps.metrics ?? createInMemoryMetrics();
  // The cache shares the injected clock so a frozen test clock also freezes
  // cache expiry, keeping TTL behaviour deterministic under test.
  const cache = deps.cache ?? createMemoryCache({ clock });
  const locations = deps.locations ?? createLocationService(CMU_LOCATIONS);

  const parser = createSemanticParser({ taxonomy, cache, llm: deps.llm, config, metrics });

  const recommendation = createRecommendationService({
    events: deps.events,
    cache,
    taxonomy,
    locations,
    config,
    clock,
    metrics,
  });

  const matching = createMatchingService({
    events: deps.events,
    taxonomy,
    locations,
    config,
    clock,
    metrics,
    parser,
    profiles: deps.profiles,
    availability: deps.availability,
    idempotency: deps.idempotency,
  });

  const suggestions = createSuggestionService({
    events: deps.events,
    taxonomy,
    locations,
    cache,
    config,
    clock,
    metrics,
    profiles: deps.profiles,
    popularity: deps.popularity,
  });

  return {
    recommend: (intent, userId) => recommendation.recommend(intent, userId),
    match: (userId, intent) => matching.match(userId, intent),
    suggestActivities: (userId, ctx) => suggestions.suggestActivities(userId, ctx),
    config,
    taxonomy,
    metrics,
  };
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type * from './core/types.js';
export type {
  ActivityNode,
  ActivitySimilarityConfig,
  AlgorithmConfig,
  CacheTtlConfig,
  LocationCompatibilityConfig,
  LocationConfig,
  ScoringWeights,
  TaxonomyConfig,
  TimeCompatibilityConfig,
} from './config/types.js';

export { DEFAULT_CONFIG, resolveConfig } from './config/defaults.js';
export type { DeepPartial } from './config/defaults.js';
export { DEFAULT_TAXONOMY, buildTaxonomy } from './config/taxonomy.js';
export { CMU_LOCATIONS, buildLocationConfig } from './config/locations.js';

export { buildTaxonomyIndex } from './core/taxonomyIndex.js';
export { normalizeText, tokenize } from './core/text.js';
export { deterministicActivityFromText, normalizeStructuredIntent } from './core/normalize.js';
export type { NormalizeStructuredIntentArgs } from './core/normalize.js';

export { createLocationService, haversineMeters } from './location/service.js';
export type { LocationServiceOptions } from './location/service.js';

export { createMemoryCache, createNullCache } from './cache/memory.js';
export { recommendationKey, semanticKey, suggestionsKey } from './cache/keys.js';

export {
  createInMemoryMetrics,
  createNoopMetrics,
  llmCallRatio,
  recommendationCacheHitRate,
  semanticCacheHitRate,
} from './observability/metrics.js';
export type { MetricsSnapshot, ObservedStats } from './observability/metrics.js';

export { createInMemoryEventRepository } from './adapters/inMemoryEventRepository.js';
export { createInMemoryIdempotencyStore } from './adapters/inMemoryIdempotencyStore.js';
export { fixedClock, systemClock } from './adapters/clock.js';
export { createAnthropicLlmClient, createNullLlmClient } from './adapters/anthropicLlmClient.js';
export type { AnthropicLlmClientOptions, FetchLike } from './adapters/anthropicLlmClient.js';

export { createSemanticParser } from './semantic/parser.js';
export type { SemanticParserDeps } from './semantic/parser.js';
export { SEMANTIC_OUTPUT_JSON_SCHEMA, validateSemanticOutput } from './semantic/schema.js';

export { buildCandidateQuery } from './retrieval/candidates.js';
export { hardFilter } from './retrieval/hardFilters.js';
export type { HardFilterDeps } from './retrieval/hardFilters.js';

export { assertWeightsSumToOne, rankCandidates, scoreEvent } from './scoring/score.js';
export type { RankerDeps } from './scoring/score.js';
export { activityScore } from './scoring/activity.js';
export { locationCompatibility } from './scoring/location.js';
export { qualityScore } from './scoring/quality.js';
export { tagScore } from './scoring/tags.js';
export { timeOverlapMinutes, timeScore } from './scoring/time.js';

export { MAX_DURATION_MINUTES, resolveDuration } from './time/duration.js';
export { DAY_PART_HOUR_OF_DAY, parseRelativeTime, stripTimePhrases } from './time/relative.js';
export { resolveTime } from './time/resolve.js';
export type { ResolveTimeArgs } from './time/resolve.js';

export { createRecommendationService } from './services/recommendation.js';
export type { RecommendationServiceDeps } from './services/recommendation.js';
export {
  UNSPECIFIED_LOCATION_ID,
  createMatchingService,
} from './services/matching.js';
export type { MatchingServiceDeps } from './services/matching.js';
export {
  NEUTRAL_TIME_OF_DAY_FIT,
  RECENCY_DECAY_PER_POSITION,
  SUGGESTION_WEIGHTS,
  TIME_OF_DAY_BOUNDARIES,
  TIME_OF_DAY_FIT,
  createSuggestionService,
  timeOfDayOf,
} from './services/suggestions.js';
export type {
  ActivityPopularitySource,
  ActivitySuggestion,
  SuggestionContext,
  SuggestionReason,
  SuggestionService,
  SuggestionServiceDeps,
  TimeOfDay,
} from './services/suggestions.js';
