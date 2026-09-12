/**
 * §20-§21 — the real-time *advisory* recommendation path.
 *
 * ## The hard requirement: ZERO LLM calls, ever
 *
 * This is enforced structurally, not by discipline:
 *
 *  1. This module imports **no** LLM symbol. There is no `LlmClient`, no
 *     `SemanticParser`, and no `createSemanticParser` in scope, so no call
 *     site can exist — an LLM call here would be a compile error, not a
 *     code-review miss.
 *  2. `RecommendationServiceDeps` declares `llm?: never` and `parser?: never`.
 *     Any caller that tries to hand this service an LLM or a semantic parser
 *     fails to type-check. The dependency simply cannot be supplied, so it
 *     cannot later be "temporarily" used.
 *
 * Free text is therefore only ever consulted through
 * `deterministicActivityFromText` (exact id -> synonym -> longest token) and
 * through the deterministic relative-time parser. Anything that would need
 * real semantic interpretation is ignored on this path; the authoritative
 * `match` path is where an LLM is allowed to help.
 *
 * ## Strictly read-only
 *
 * No `createEvent`, no `joinEventAtomically`, no `AvailabilityService`, no
 * `IdempotencyStore`. The only dependency that can write is the `CacheService`,
 * and only to its own advisory entry. Results carry `advisory: true` precisely
 * because they may be stale — `match` revalidates every join transactionally.
 */
import type {
  CacheService,
  Clock,
  EventRepository,
  LocationService,
  MatchableEvent,
  Metrics,
  NormalizedIntent,
  RawIntent,
  Recommendation,
  RecommendationResult,
  RecommendationService,
  ScoredEvent,
  TaxonomyIndex,
  UserId,
} from '../core/types.js';
import type { AlgorithmConfig } from '../config/types.js';
import { deterministicActivityFromText, normalizeStructuredIntent } from '../core/normalize.js';
import { boundedText, recommendationKey } from '../cache/keys.js';
import { buildCandidateQuery } from '../retrieval/candidates.js';
import { hardFilter } from '../retrieval/hardFilters.js';
import { rankCandidates } from '../scoring/score.js';
import { resolveTime } from '../time/resolve.js';

export interface RecommendationServiceDeps {
  events: EventRepository;
  cache: CacheService;
  taxonomy: TaxonomyIndex;
  locations: LocationService;
  config: AlgorithmConfig;
  clock: Clock;
  metrics: Metrics;

  /**
   * Compile-time guards. These exist only so that passing an LLM client or a
   * semantic parser into the real-time path is a type error. Never assign them.
   */
  llm?: never;
  parser?: never;
}

/**
 * A fresh object per call, deliberately not a shared singleton: the result is
 * handed to callers who may reasonably mutate or sort it, and one caller must
 * never be able to affect another's.
 */
function emptyResult(): RecommendationResult {
  return { recommendations: [], advisory: true, cacheHit: false };
}

export function createRecommendationService(deps: RecommendationServiceDeps): RecommendationService {
  const { events, cache, taxonomy, locations, config, clock, metrics } = deps;

  async function recommend(intent: RawIntent, userId?: UserId): Promise<RecommendationResult> {
    // Wall-clock elapsed time, deliberately NOT `clock.now()`: the injected
    // Clock is the domain clock (frozen in tests), which would report every
    // request as 0 ms. Latency is an operational measurement, not a domain
    // decision, so it uses real time.
    const startedAtMs = Date.now();
    const now = clock.now();

    try {
      const normalized = withDeterministicText(
        normalizeStructuredIntent({ intent, taxonomy, locations, config }),
        taxonomy,
      );

      // No activity resolvable from structured input and none from the
      // deterministic text layer. Return immediately WITHOUT touching the
      // repository or the cache — there is nothing to query for, and an LLM
      // escalation (which would be the only way to do better) is forbidden here.
      if (normalized.activityIds.length === 0) return emptyResult();

      const timed = await resolveAdvisoryTime(intent, normalized, config, now);
      const scopedIntent: NormalizedIntent = {
        ...normalized,
        startTime: timed?.startTime,
        endTime: timed?.endTime,
      };

      const key = cacheKeyFor(scopedIntent, now, config, userId);

      const cached = await readCache(cache, key);
      if (cached !== undefined) {
        metrics.increment('recommendation.cache.hit');
        return { recommendations: reviveRecommendations(cached), advisory: true, cacheHit: true };
      }
      metrics.increment('recommendation.cache.miss');

      const query = buildCandidateQuery({
        intent: scopedIntent,
        taxonomy,
        config,
        now,
        excludeUserId: userId,
      });
      const candidates: MatchableEvent[] = await events.findCandidates(query);
      // Stage-1 retrieval size: what the repository actually returned, before
      // hard filtering. That is the number that tells you whether the query is
      // too narrow (0) or is hitting `candidateLimit` (too broad).
      metrics.observe('recommendation.candidates', candidates.length);

      const { kept } = hardFilter({
        intent: scopedIntent,
        events: candidates,
        deps: { taxonomy, locations, config },
        now,
        userId,
      });

      const ranked: ScoredEvent[] = rankCandidates(
        scopedIntent,
        kept,
        { taxonomy, locations, config },
        now,
      );
      const recommendations: Recommendation[] = ranked
        .slice(0, config.recommendationLimit)
        .map(toRecommendation);

      await writeCache(cache, key, recommendations, config.cache.recommendationMs);

      return { recommendations, advisory: true, cacheHit: false };
    } finally {
      metrics.observe('recommendation.latency_ms', Date.now() - startedAtMs);
    }
  }

  return { recommend };
}

/**
 * When the structured selections yielded nothing, fall back to the
 * deterministic text layer only. `sourceText` is already normalized by
 * `normalizeStructuredIntent`, and `deterministicActivityFromText` is pure —
 * no cache lookup, no LLM, no network.
 */
function withDeterministicText(
  normalized: NormalizedIntent,
  taxonomy: TaxonomyIndex,
): NormalizedIntent {
  if (normalized.activityIds.length > 0) return normalized;
  if (normalized.sourceText === undefined) return normalized;

  const activityId = deterministicActivityFromText(normalized.sourceText, taxonomy);
  if (activityId === undefined) return normalized;

  const categoryId = taxonomy.categoryOf(activityId);
  return {
    ...normalized,
    activityIds: [activityId],
    categoryIds: categoryId === undefined ? [] : [categoryId],
    tags: taxonomy.tagsFor(activityId),
  };
}

/**
 * Time resolution for the advisory path: explicit time, else a deterministic
 * relative phrase, else **nothing**.
 *
 * `resolveTime` is reused (rather than reimplemented) so the explicit ->
 * relative precedence, the invalid-window rejection and the duration lookup
 * all behave identically to the authoritative path. It is called without
 * `availability`/`userId`, which is what makes this read-only: case 3 of
 * `resolveTime` is skipped entirely and "no time signal" surfaces as
 * `DEFAULT_FALLBACK`.
 *
 * We then deliberately **discard** a `DEFAULT_FALLBACK` window. Inventing a
 * `now + 15min` start for a user who named no time would silently bias the
 * ranking toward a time they never asked for; leaving `startTime` undefined
 * makes `timeScore` return its documented neutral 0.5 and makes
 * `buildCandidateQuery` scan forward from `now`, which is the honest
 * interpretation of "no time preference".
 */
async function resolveAdvisoryTime(
  intent: RawIntent,
  normalized: NormalizedIntent,
  config: AlgorithmConfig,
  now: Date,
): Promise<{ startTime: Date; endTime: Date } | undefined> {
  const resolved = await resolveTime({
    explicitStart: intent.startTime,
    explicitEnd: intent.endTime,
    normalizedText: normalized.sourceText,
    activityId: normalized.activityIds[0],
    explicitDurationMinutes: intent.durationMinutes,
    config,
    now,
  });
  if (resolved.source === 'DEFAULT_FALLBACK') return undefined;
  return { startTime: resolved.startTime, endTime: resolved.endTime };
}

/**
 * `recommendationKey` intentionally keys only on the normalized intent
 * (activities / categories / locations / bucketed time). Results are however
 * **user-scoped**: `excludeUserId` removes the caller's own and already-joined
 * events, and `hardFilter` rejects `OWN_EVENT` / `ALREADY_PARTICIPANT`. Serving
 * user A's cached list to user B would therefore show B their own events back.
 * So the pinned key is used verbatim and prefixed with the caller's scope;
 * anonymous callers (no `userId`) share one entry, which is correct because
 * their results are genuinely identical.
 */
function cacheKeyFor(
  intent: NormalizedIntent,
  now: Date,
  config: AlgorithmConfig,
  userId?: UserId,
): string {
  const base = recommendationKey({
    activityIds: intent.activityIds,
    categoryIds: intent.categoryIds,
    locationIds: intent.locationIds,
    startTime: intent.startTime,
    now,
    bucketMs: config.cache.recommendationTimeBucketMs,
  });
  return userId === undefined ? `${base}:anon` : `${base}:u=${boundedText(userId)}`;
}

/**
 * Rebuild the `Date` fields on a cached entry.
 *
 * `CacheService` is an abstraction over backends we do not control, and the
 * whole point of it is that the in-memory default can be swapped for Redis.
 * An in-process Map hands back the very objects we stored, but any backend
 * that serializes (JSON, and therefore most shared caches) hands back ISO
 * strings statically typed as `Date` — callers would then hit
 * `event.startTime.getTime is not a function` at runtime, with nothing in the
 * type system to warn them.
 *
 * `new Date(x)` accepts both a `Date` and its ISO string, so this is correct
 * and idempotent for either kind of backend. It also gives each caller its own
 * object graph, so one caller mutating a recommendation cannot corrupt the
 * cached entry or another caller's copy.
 */
function reviveRecommendations(cached: Recommendation[]): Recommendation[] {
  return cached.map((rec) => ({
    ...rec,
    event: {
      ...rec.event,
      startTime: new Date(rec.event.startTime),
      endTime: new Date(rec.event.endTime),
      createdAt: new Date(rec.event.createdAt),
      expiresAt: new Date(rec.event.expiresAt),
    },
  }));
}

/** A flaky cache backend degrades to a miss; it never fails an advisory read. */
async function readCache(
  cache: CacheService,
  key: string,
): Promise<Recommendation[] | undefined> {
  try {
    return await cache.get<Recommendation[]>(key);
  } catch {
    return undefined;
  }
}

/** Best-effort write: a cache outage must not turn a good result into an error. */
async function writeCache(
  cache: CacheService,
  key: string,
  value: Recommendation[],
  ttlMs: number,
): Promise<void> {
  try {
    await cache.set(key, value, ttlMs);
  } catch {
    // intentionally ignored
  }
}

function toRecommendation(scored: ScoredEvent): Recommendation {
  return {
    eventId: scored.event.id,
    score: scored.score,
    breakdown: scored.breakdown,
    event: scored.event,
  };
}
