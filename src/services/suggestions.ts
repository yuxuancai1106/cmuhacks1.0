/**
 * §22 — personalized activity suggestions for the "what should I do?" surface.
 *
 * Fully deterministic and **LLM-free**: this is a ranking over the controlled
 * vocabulary, not an interpretation problem. There is no free text here at all,
 * so there is nothing for a semantic parser to do. As in
 * `recommendation.ts`, the dependency type carries `llm?: never` / `parser?: never`
 * so an LLM cannot be wired in later without a compile error.
 *
 * Five signals, blended by `SUGGESTION_WEIGHTS`:
 *   PROFILE_INTEREST  what the user's profile says they like (taxonomy-graded)
 *   RECENT            what they have actually done lately (position-decayed)
 *   TIME_OF_DAY       whether this activity fits the current hour
 *   NEARBY_ACTIVITY   open events at the user's current location
 *   POPULAR           open events across campus
 *
 * Then a diversity constraint, so the UI never shows
 * Workout / Running / Treadmill / Gym / Cardio as five separate suggestions.
 */
import type {
  ActivityId,
  CacheService,
  CandidateQuery,
  CategoryId,
  Clock,
  Coordinates,
  EventRepository,
  LocationId,
  LocationService,
  MatchableEvent,
  Metrics,
  TaxonomyIndex,
  UserId,
  UserProfile,
  UserProfileService,
} from '../core/types.js';
import type { AlgorithmConfig } from '../config/types.js';
import { suggestionsKey } from '../cache/keys.js';

export interface SuggestionContext {
  coordinates?: Coordinates;
  locationIds?: LocationId[];
  at?: Date;
}

export type SuggestionReason =
  | 'PROFILE_INTEREST'
  | 'RECENT'
  | 'TIME_OF_DAY'
  | 'NEARBY_ACTIVITY'
  | 'POPULAR';

export interface ActivitySuggestion {
  activityId: ActivityId;
  categoryId: CategoryId;
  score: number;
  reason: SuggestionReason[];
}

/**
 * Optional injection point for campus popularity.
 *
 * The default derivation (below) sweeps open events through
 * `EventRepository.findCandidates`. That is correct and needs no extra
 * infrastructure, but it is one broad query per cache miss. A production
 * deployment should inject a cheap pre-aggregated source instead — a
 * materialized view, a counter table, or a periodically refreshed in-memory
 * snapshot — since "how many open events per activity" is exactly the kind of
 * thing you compute once per minute, not once per user.
 */
export interface ActivityPopularitySource {
  /** Open-event counts keyed by activity id, as of `now`. */
  getOpenEventCounts(now: Date): Promise<Record<ActivityId, number>> | Record<ActivityId, number>;
}

export interface SuggestionServiceDeps {
  events: EventRepository;
  taxonomy: TaxonomyIndex;
  locations: LocationService;
  cache: CacheService;
  config: AlgorithmConfig;
  clock: Clock;
  metrics: Metrics;
  profiles?: UserProfileService;
  popularity?: ActivityPopularitySource;

  /** Compile-time guards: §22 is a deterministic path. Never assign these. */
  llm?: never;
  parser?: never;
}

export interface SuggestionService {
  suggestActivities(userId: UserId, ctx?: SuggestionContext): Promise<ActivitySuggestion[]>;
}

// ---------------------------------------------------------------------------
// Time-of-day table
// ---------------------------------------------------------------------------

export type TimeOfDay =
  | 'EARLY_MORNING'
  | 'MORNING'
  | 'MIDDAY'
  | 'AFTERNOON'
  | 'EVENING'
  | 'NIGHT';

/**
 * Local-hour boundaries for each bucket, as `[inclusiveStartHour, exclusiveEndHour)`.
 * `NIGHT` wraps midnight and is the implicit complement of the others.
 *
 * Local time, deliberately: these are wall-clock human rhythms ("nobody wants
 * lunch at 3am"), so they are read off the injected `Date`'s local calendar
 * fields, exactly like `src/time/relative.ts`. The surrounding app owns
 * timezone policy.
 */
export const TIME_OF_DAY_BOUNDARIES: ReadonlyArray<{
  bucket: Exclude<TimeOfDay, 'NIGHT'>;
  startHour: number;
  endHour: number;
}> = [
  { bucket: 'EARLY_MORNING', startHour: 5, endHour: 8 },
  { bucket: 'MORNING', startHour: 8, endHour: 11 },
  { bucket: 'MIDDAY', startHour: 11, endHour: 14 },
  { bucket: 'AFTERNOON', startHour: 14, endHour: 17 },
  { bucket: 'EVENING', startHour: 17, endHour: 21 },
];

/**
 * Fit of an activity to a time of day, in [0, 1]. An activity absent from a
 * bucket's map scores `NEUTRAL_TIME_OF_DAY_FIT` — "no opinion", not "bad fit",
 * which is what a custom taxonomy's unknown activities should get.
 *
 * Values are editorial judgements about student life on a campus, not measured
 * data: a 6am run is a normal thing and a 6am lunch is not. Replace this table
 * wholesale once you have real engagement data; it is exported precisely so it
 * can be inspected, tested, and swapped.
 */
export const NEUTRAL_TIME_OF_DAY_FIT = 0.5;

export const TIME_OF_DAY_FIT: Readonly<Record<TimeOfDay, Readonly<Record<ActivityId, number>>>> = {
  EARLY_MORNING: {
    running: 1.0, treadmill: 0.9, workout: 0.9, coffee: 0.8, walking: 0.7, photography: 0.7,
    basketball: 0.4, studying: 0.4, homework: 0.3, coding: 0.3, programming: 0.3,
    drawing: 0.3, painting: 0.3, robotics: 0.2, lunch: 0.0,
  },
  MORNING: {
    coffee: 1.0, studying: 0.8, homework: 0.8, workout: 0.7, running: 0.7, treadmill: 0.7,
    coding: 0.7, programming: 0.7, robotics: 0.6, walking: 0.6, photography: 0.6,
    drawing: 0.5, painting: 0.5, basketball: 0.4, lunch: 0.1,
  },
  MIDDAY: {
    lunch: 1.0, walking: 0.8, coffee: 0.7, basketball: 0.6, photography: 0.6,
    studying: 0.5, homework: 0.5, coding: 0.5, programming: 0.5, robotics: 0.5,
    drawing: 0.5, painting: 0.5, workout: 0.5, running: 0.5, treadmill: 0.5,
  },
  AFTERNOON: {
    basketball: 0.9, workout: 0.8, running: 0.8, treadmill: 0.8, studying: 0.8, homework: 0.8,
    coding: 0.8, programming: 0.8, robotics: 0.8, photography: 0.8, drawing: 0.7, painting: 0.7,
    walking: 0.7, coffee: 0.6, lunch: 0.2,
  },
  EVENING: {
    coding: 0.9, programming: 0.9, studying: 0.9, homework: 0.9, basketball: 0.8, robotics: 0.8,
    drawing: 0.8, painting: 0.8, workout: 0.7, treadmill: 0.7, walking: 0.7, running: 0.6,
    photography: 0.5, coffee: 0.5, lunch: 0.2,
  },
  NIGHT: {
    coding: 0.9, programming: 0.9, studying: 0.9, homework: 0.9, robotics: 0.6,
    drawing: 0.6, painting: 0.6, treadmill: 0.5, walking: 0.4, coffee: 0.4,
    workout: 0.3, running: 0.3, basketball: 0.2, photography: 0.2, lunch: 0.1,
  },
};

/** Which bucket a local wall-clock time falls into. */
export function timeOfDayOf(at: Date): TimeOfDay {
  const hour = at.getHours();
  for (const band of TIME_OF_DAY_BOUNDARIES) {
    if (hour >= band.startHour && hour < band.endHour) return band.bucket;
  }
  return 'NIGHT';
}

// ---------------------------------------------------------------------------
// Blend weights
// ---------------------------------------------------------------------------

/**
 * Sums to 1, so `ActivitySuggestion.score` is directly comparable and lives in
 * [0, 1]. Profile interest leads because a stated preference is the strongest
 * signal we have; popularity and proximity are tie-breakers that surface
 * things actually happening right now.
 */
export const SUGGESTION_WEIGHTS = {
  profileInterest: 0.30,
  recent: 0.20,
  timeOfDay: 0.20,
  nearby: 0.15,
  popular: 0.15,
} as const;

/**
 * Per-position decay applied to `UserProfile.recentActivityIds` (index 0 is the
 * most recent). Geometric rather than linear so a long history tail cannot
 * outweigh what the user did yesterday.
 */
export const RECENCY_DECAY_PER_POSITION = 0.8;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const MS_PER_MINUTE = 60_000;

export function createSuggestionService(deps: SuggestionServiceDeps): SuggestionService {
  const { events, taxonomy, locations, cache, config, clock, metrics, profiles, popularity } = deps;

  async function suggestActivities(
    userId: UserId,
    ctx?: SuggestionContext,
  ): Promise<ActivitySuggestion[]> {
    const now = ctx?.at ?? clock.now();
    const contextLocationIds = resolveContextLocations(ctx, locations);

    // Bucketing the clock by the cache TTL means a user hammering the screen
    // shares one entry, while the suggestion set still rolls over as the day
    // moves through the time-of-day table.
    const bucket = Math.floor(now.getTime() / Math.max(1, config.cache.suggestionsMs));
    // EVERY context location belongs in the key, not just the first: the
    // nearby sweep in `loadEventCounts` filters on the whole list, so two
    // contexts that merely share a first id produce different NEARBY_ACTIVITY
    // scores and must not share a cache entry. Sorted so the key is
    // order-insensitive, matching `recommendationKey`'s id segments;
    // `suggestionsKey` bounds the segment's length.
    const locationScope =
      contextLocationIds.length === 0 ? undefined : [...contextLocationIds].sort().join(',');
    const key = suggestionsKey(userId, bucket, locationScope);

    const cached = await readCache(cache, key);
    if (cached !== undefined) {
      metrics.increment('suggestions.cache.hit');
      return cached;
    }
    metrics.increment('suggestions.cache.miss');

    const profile = await loadProfile(profiles, userId);
    const counts = await loadEventCounts({
      events,
      taxonomy,
      config,
      popularity,
      now,
      contextLocationIds,
    });

    const suggestions = rankVocabulary({
      taxonomy,
      config,
      profile,
      now,
      openCountByActivity: counts.openCountByActivity,
      nearbyCountByActivity: counts.nearbyCountByActivity,
    });

    const diversified = applyDiversity(suggestions, config);
    await writeCache(cache, key, diversified, config.cache.suggestionsMs);
    return diversified;
  }

  return { suggestActivities };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function rankVocabulary(args: {
  taxonomy: TaxonomyIndex;
  config: AlgorithmConfig;
  profile: UserProfile | null;
  now: Date;
  openCountByActivity: ReadonlyMap<ActivityId, number>;
  nearbyCountByActivity: ReadonlyMap<ActivityId, number>;
}): ActivitySuggestion[] {
  const { taxonomy, config, profile, now, openCountByActivity, nearbyCountByActivity } = args;

  const bucket = timeOfDayOf(now);
  const fitTable = TIME_OF_DAY_FIT[bucket];
  const maxOpen = maxOf(openCountByActivity);
  const maxNearby = maxOf(nearbyCountByActivity);

  const scored: ActivitySuggestion[] = [];
  for (const activityId of taxonomy.allActivityIds()) {
    const categoryId = taxonomy.categoryOf(activityId);
    if (categoryId === undefined) continue;

    const profileInterest = profileInterestScore(activityId, categoryId, profile, taxonomy, config);
    const recent = recentScore(activityId, profile, taxonomy);
    const timeOfDay = fitTable[activityId] ?? NEUTRAL_TIME_OF_DAY_FIT;
    const nearby = maxNearby === 0 ? 0 : (nearbyCountByActivity.get(activityId) ?? 0) / maxNearby;
    const popular = maxOpen === 0 ? 0 : (openCountByActivity.get(activityId) ?? 0) / maxOpen;

    const score =
      SUGGESTION_WEIGHTS.profileInterest * profileInterest +
      SUGGESTION_WEIGHTS.recent * recent +
      SUGGESTION_WEIGHTS.timeOfDay * timeOfDay +
      SUGGESTION_WEIGHTS.nearby * nearby +
      SUGGESTION_WEIGHTS.popular * popular;

    const reason: SuggestionReason[] = [];
    if (profileInterest > 0) reason.push('PROFILE_INTEREST');
    if (recent > 0) reason.push('RECENT');
    // Only when the hour is actively in this activity's favour: a neutral or
    // poor fit is not a reason to suggest something.
    if (timeOfDay > NEUTRAL_TIME_OF_DAY_FIT) reason.push('TIME_OF_DAY');
    if (nearby > 0) reason.push('NEARBY_ACTIVITY');
    if (popular > 0) reason.push('POPULAR');

    scored.push({ activityId, categoryId, score, reason });
  }

  // Deterministic total order: score descending, then activity id ascending so
  // repeated calls (and cached vs. recomputed results) never disagree.
  return scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.activityId < b.activityId ? -1 : a.activityId > b.activityId ? 1 : 0;
  });
}

/**
 * Graded against the taxonomy rather than a set membership test: a user who
 * listed `running` should also see `treadmill` surface, just lower. Category
 * interests contribute at `activitySimilarity.sameCategory`, the same value the
 * ranking scorer uses for "related only by category".
 */
function profileInterestScore(
  activityId: ActivityId,
  categoryId: CategoryId,
  profile: UserProfile | null,
  taxonomy: TaxonomyIndex,
  config: AlgorithmConfig,
): number {
  if (profile === null) return 0;

  let best = 0;
  for (const interestId of profile.interestActivityIds) {
    const similarity = taxonomy.similarity(interestId, activityId);
    if (similarity > best) best = similarity;
  }
  if (profile.interestCategoryIds.includes(categoryId)) {
    best = Math.max(best, config.activitySimilarity.sameCategory);
  }
  return best;
}

function recentScore(
  activityId: ActivityId,
  profile: UserProfile | null,
  taxonomy: TaxonomyIndex,
): number {
  const recents = profile?.recentActivityIds;
  if (recents === undefined) return 0;

  let best = 0;
  for (const [index, recentId] of recents.entries()) {
    const decayed =
      taxonomy.similarity(recentId, activityId) * Math.pow(RECENCY_DECAY_PER_POSITION, index);
    if (decayed > best) best = decayed;
  }
  return best;
}

/**
 * The diversity constraint. Walks the ranked list once, admitting an activity
 * only while its category is under `config.maxSuggestionsPerCategory`, and
 * stops at `config.suggestionLimit`. Because the list is already sorted, each
 * category contributes its own best entries — so "Workout" and "Running" can
 * both appear, but "Treadmill", "Gym" and "Cardio" do not pile on behind them.
 */
function applyDiversity(
  ranked: ActivitySuggestion[],
  config: AlgorithmConfig,
): ActivitySuggestion[] {
  const perCategory = new Map<CategoryId, number>();
  const kept: ActivitySuggestion[] = [];

  for (const suggestion of ranked) {
    if (kept.length >= config.suggestionLimit) break;
    const used = perCategory.get(suggestion.categoryId) ?? 0;
    if (used >= config.maxSuggestionsPerCategory) continue;
    perCategory.set(suggestion.categoryId, used + 1);
    kept.push(suggestion);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Popularity / proximity inputs
// ---------------------------------------------------------------------------

interface EventCounts {
  openCountByActivity: ReadonlyMap<ActivityId, number>;
  nearbyCountByActivity: ReadonlyMap<ActivityId, number>;
}

/**
 * Campus popularity, and the location-scoped slice of it.
 *
 * With an injected `ActivityPopularitySource` we use its counts for popularity
 * and skip the sweep; proximity then needs its own (small, location-filtered)
 * query. Without one, a single unfiltered sweep produces both numbers.
 *
 * Either way this is best-effort: a repository hiccup degrades suggestions to
 * "profile + time of day", which is still a usable screen (§30).
 */
async function loadEventCounts(args: {
  events: EventRepository;
  taxonomy: TaxonomyIndex;
  config: AlgorithmConfig;
  popularity: ActivityPopularitySource | undefined;
  now: Date;
  contextLocationIds: LocationId[];
}): Promise<EventCounts> {
  const { events, taxonomy, config, popularity, now, contextLocationIds } = args;

  if (popularity !== undefined) {
    const injected = await safely(() => popularity.getOpenEventCounts(now), {});
    const openCountByActivity = new Map(Object.entries(injected));
    const nearby =
      contextLocationIds.length === 0
        ? []
        : await safely(
            () => events.findCandidates(sweepQuery(taxonomy, config, now, contextLocationIds)),
            [] as MatchableEvent[],
          );
    return { openCountByActivity, nearbyCountByActivity: countByActivity(nearby) };
  }

  const open = await safely(
    () => events.findCandidates(sweepQuery(taxonomy, config, now, [])),
    [] as MatchableEvent[],
  );
  const nearbySet = new Set(contextLocationIds);
  const nearby =
    nearbySet.size === 0 ? [] : open.filter((event) => nearbySet.has(event.locationId));

  return {
    openCountByActivity: countByActivity(open),
    nearbyCountByActivity: countByActivity(nearby),
  };
}

/**
 * A bounded, index-friendly sweep of what is currently open. Built directly
 * rather than through `buildCandidateQuery` because there is no intent to
 * expand here — we deliberately want the *whole* vocabulary, not a widened
 * neighbourhood of one activity.
 */
function sweepQuery(
  taxonomy: TaxonomyIndex,
  config: AlgorithmConfig,
  now: Date,
  locationIds: LocationId[],
): CandidateQuery {
  const activityIds = taxonomy.allActivityIds();
  const categoryIds = [
    ...new Set(
      activityIds
        .map((id) => taxonomy.categoryOf(id))
        .filter((id): id is CategoryId => id !== undefined),
    ),
  ];
  return {
    activityIds,
    categoryIds,
    locationIds,
    windowStart: now,
    windowEnd: new Date(now.getTime() + config.retrievalWindowMinutes * MS_PER_MINUTE),
    now,
    limit: config.candidateLimit,
  };
}

function countByActivity(events: MatchableEvent[]): ReadonlyMap<ActivityId, number> {
  const counts = new Map<ActivityId, number>();
  for (const event of events) {
    counts.set(event.activityId, (counts.get(event.activityId) ?? 0) + 1);
  }
  return counts;
}

function maxOf(counts: ReadonlyMap<ActivityId, number>): number {
  let max = 0;
  for (const value of counts.values()) {
    if (value > max) max = value;
  }
  return max;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Explicit ids win (validated); otherwise device coordinates resolve to one. */
function resolveContextLocations(
  ctx: SuggestionContext | undefined,
  locations: LocationService,
): LocationId[] {
  const explicit = (ctx?.locationIds ?? []).filter(
    (id) => locations.getLocation(id) !== undefined,
  );
  if (explicit.length > 0) return [...new Set(explicit)];

  const coordinates = ctx?.coordinates;
  if (coordinates !== undefined) {
    const nearest = locations.resolveNearestLocation(coordinates.latitude, coordinates.longitude);
    if (nearest !== null) return [nearest.id];
  }
  return [];
}

async function safely<T>(run: () => Promise<T> | T, fallback: T): Promise<T> {
  try {
    return await run();
  } catch {
    return fallback;
  }
}

async function loadProfile(
  profiles: UserProfileService | undefined,
  userId: UserId,
): Promise<UserProfile | null> {
  if (profiles === undefined) return null;
  try {
    return await profiles.getProfile(userId);
  } catch {
    return null;
  }
}

async function readCache(
  cache: CacheService,
  key: string,
): Promise<ActivitySuggestion[] | undefined> {
  try {
    return await cache.get<ActivitySuggestion[]>(key);
  } catch {
    return undefined;
  }
}

async function writeCache(
  cache: CacheService,
  key: string,
  value: ActivitySuggestion[],
  ttlMs: number,
): Promise<void> {
  try {
    await cache.set(key, value, ttlMs);
  } catch {
    // best effort
  }
}
