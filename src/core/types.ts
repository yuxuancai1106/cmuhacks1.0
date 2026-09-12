/**
 * Core domain contracts for the activity recommendation & matching algorithm.
 *
 * Design rule (see README): LLMs interpret ambiguous human intent; deterministic
 * code and the database decide matches. Nothing in this file may depend on a
 * concrete database, HTTP framework, or LLM vendor.
 *
 * The surrounding application owns the real schema. It adapts its rows onto the
 * read models here (`MatchableEvent`, `UserProfile`) and implements the ports.
 */

export type UserId = string;
export type EventId = string;
export type ActivityId = string;
export type CategoryId = string;
export type LocationId = string;

/** Lifecycle states the matcher cares about. Apps with richer states map onto these. */
export type EventStatus = 'OPEN' | 'MATCHED' | 'CANCELLED' | 'EXPIRED' | 'COMPLETED';

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

/** Raw input as it arrives from the UI / API. Never trusted for profile data. */
export interface RawIntent {
  /** Structured activity selections (buttons). */
  activityIds?: ActivityId[];
  /** Optional free text typed by the user. */
  text?: string;
  /** Explicit absolute start, if the user picked one. */
  startTime?: Date;
  /** Explicit absolute end, if the user picked one. */
  endTime?: Date;
  /** Explicit duration in minutes, if the user picked one. */
  durationMinutes?: number;
  /** Canonical locations the user selected. */
  locationIds?: LocationId[];
  /** Device coordinates, resolved deterministically to a canonical location. */
  coordinates?: Coordinates;
  /** Client-supplied idempotency key for the core matching path. */
  idempotencyKey?: string;
}

export interface Coordinates {
  latitude: number;
  longitude: number;
}

/**
 * The canonical form every matching operation runs on.
 * Mirrors the spec's `NormalizedIntent`, extended with the fields the
 * deterministic scorers need.
 */
export interface NormalizedIntent {
  activityIds: ActivityId[];
  categoryIds: CategoryId[];
  tags: string[];

  startTime?: Date;
  endTime?: Date;

  locationIds: LocationId[];

  /** Original free text, normalized. Kept for cache keys and debugging only. */
  sourceText?: string;
}

/** How the time window on a normalized intent was arrived at. */
export type TimeResolutionSource =
  | 'EXPLICIT'
  | 'RELATIVE_TEXT'
  | 'AVAILABILITY'
  | 'DEFAULT_FALLBACK';

export interface ResolvedTime {
  startTime: Date;
  endTime: Date;
  source: TimeResolutionSource;
}

// ---------------------------------------------------------------------------
// Semantic parsing
// ---------------------------------------------------------------------------

/** Structured output of semantic interpretation of free text. */
export interface SemanticInterpretation {
  canonicalActivity: ActivityId;
  category: CategoryId;
  tags: string[];
  confidence: number;
}

/** How a semantic interpretation was obtained — drives the LLM-usage metric. */
export type SemanticSource = 'DETERMINISTIC' | 'CACHE' | 'LLM' | 'FALLBACK';

export interface SemanticParseResult {
  interpretation: SemanticInterpretation | null;
  source: SemanticSource;
  /** Present when source === 'FALLBACK' and parsing degraded gracefully. */
  degradedReason?: string;
}

export interface SemanticParser {
  /**
   * Deterministic lookup -> cache -> LLM, in that order. Must never throw for
   * LLM failures; degrade to a FALLBACK result instead.
   */
  parse(text: string, signal?: AbortSignal): Promise<SemanticParseResult>;
}

/** Vendor-neutral LLM port. The Anthropic adapter lives in src/adapters. */
export interface LlmClient {
  /**
   * Return a JSON object matching the semantic-extraction schema.
   * Implementations should request structured output and keep the prompt short.
   */
  extractSemantics(text: string, signal?: AbortSignal): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Read model the matcher scores against. The app projects its rows onto this. */
export interface MatchableEvent {
  id: EventId;
  creatorId: UserId;
  status: EventStatus;

  activityId: ActivityId;
  categoryId: CategoryId;
  tags: string[];

  startTime: Date;
  endTime: Date;

  locationId: LocationId;

  capacity: number;
  participantCount: number;
  participantIds?: UserId[];

  createdAt: Date;
  /** Matching closes at this instant. Query-time filtering is authoritative. */
  expiresAt: Date;
}

/** Fields required to create a new event when nothing compatible exists. */
export interface EventDraft {
  creatorId: UserId;
  activityId: ActivityId;
  categoryId: CategoryId;
  tags: string[];
  startTime: Date;
  endTime: Date;
  locationId: LocationId;
  capacity: number;
  status: 'OPEN';
  createdAt: Date;
  expiresAt: Date;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface ScoreBreakdown {
  activity: number;
  time: number;
  location: number;
  tag: number;
  quality: number;
}

export interface ScoredEvent {
  event: MatchableEvent;
  score: number;
  breakdown: ScoreBreakdown;
}

/** Why a candidate was eliminated before ranking. */
export type RejectionReason =
  | 'NOT_OPEN'
  | 'EXPIRED'
  | 'FULL'
  | 'ALREADY_PARTICIPANT'
  | 'OWN_EVENT'
  | 'TIME_INCOMPATIBLE'
  | 'LOCATION_INCOMPATIBLE'
  | 'ACTIVITY_INCOMPATIBLE';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** Structured, index-friendly query for stage-1 candidate retrieval. */
export interface CandidateQuery {
  /** Candidate must match one of these activities OR one of `categoryIds`. */
  activityIds: ActivityId[];
  categoryIds: CategoryId[];
  /** Empty means "no location constraint". */
  locationIds: LocationId[];
  /** Event window must intersect [windowStart, windowEnd]. */
  windowStart: Date;
  windowEnd: Date;
  /** Repository MUST enforce `expiresAt > now` and `status = 'OPEN'`. */
  now: Date;
  /** Repository MUST enforce `participantCount < capacity`. */
  limit: number;
  /** Exclude events this user already participates in / created. */
  excludeUserId?: UserId;
}

export type JoinFailureReason =
  | 'NOT_FOUND'
  | 'NOT_OPEN'
  | 'EXPIRED'
  | 'FULL'
  | 'ALREADY_PARTICIPANT';

export type JoinResult =
  | { ok: true; event: MatchableEvent }
  | { ok: false; reason: JoinFailureReason };

export interface EventRepository {
  /**
   * Stage 1. Bounded, indexed retrieval. Implementations must push
   * status / expiry / capacity filtering into the database.
   */
  findCandidates(query: CandidateQuery): Promise<MatchableEvent[]>;

  /**
   * Atomically revalidate and join in one transaction / conditional update.
   * MUST NOT be implemented as read-then-write: with capacity 4 and 3
   * participants, two concurrent callers must produce exactly one `ok: true`.
   */
  joinEventAtomically(eventId: EventId, userId: UserId, now: Date): Promise<JoinResult>;

  /** Create the event and enroll the creator as a participant atomically. */
  createEvent(draft: EventDraft): Promise<MatchableEvent>;
}

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface CacheService {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface AvailabilityService {
  /**
   * Next slot the user is free for `durationMinutes`.
   * Returns null when no availability information exists; the caller then
   * applies the configured default-time fallback rather than failing.
   */
  getNextAvailableSlot(
    userId: UserId,
    durationMinutes: number,
  ): Promise<{ startTime: Date; endTime: Date } | null>;
}

export interface CanonicalLocation {
  id: LocationId;
  name: string;
  latitude: number;
  longitude: number;
  /** Locations sharing a campus get the configured same-campus floor score. */
  campusId: string;
}

export interface LocationService {
  resolveNearestLocation(latitude: number, longitude: number): CanonicalLocation | null;
  getLocation(id: LocationId): CanonicalLocation | undefined;
  /** Great-circle distance in metres. */
  distanceMeters(a: LocationId, b: LocationId): number | null;
}

/** Authoritative profile data. Never populated from client input. */
export interface UserProfile {
  userId: UserId;
  interestActivityIds: ActivityId[];
  interestCategoryIds: CategoryId[];
  homeLocationId?: LocationId;
  recentActivityIds?: ActivityId[];
}

export interface UserProfileService {
  getProfile(userId: UserId): Promise<UserProfile | null>;
}

/** Injectable clock so time-dependent behaviour is testable and deterministic. */
export interface Clock {
  now(): Date;
}

/** Optional idempotency for the core matching path. */
export interface IdempotencyStore {
  get(userId: UserId, key: string): Promise<MatchOutcome | undefined>;
  set(userId: UserId, key: string, outcome: MatchOutcome): Promise<void>;
}

// ---------------------------------------------------------------------------
// Service results
// ---------------------------------------------------------------------------

export interface Recommendation {
  eventId: EventId;
  score: number;
  breakdown: ScoreBreakdown;
  event: MatchableEvent;
}

export interface RecommendationResult {
  recommendations: Recommendation[];
  /** Advisory only — may be stale. The core path revalidates. */
  advisory: true;
  cacheHit: boolean;
}

export type MatchOutcome =
  | {
      status: 'MATCHED';
      eventId: EventId;
      score: number;
      breakdown: ScoreBreakdown;
      event: MatchableEvent;
      semanticSource: SemanticSource | 'NONE';
      idempotentReplay?: boolean;
    }
  | {
      status: 'PENDING';
      eventId: EventId;
      event: MatchableEvent;
      /** Best score seen, when candidates existed but none cleared threshold. */
      bestRejectedScore?: number;
      semanticSource: SemanticSource | 'NONE';
      idempotentReplay?: boolean;
    }
  | {
      /**
       * Nothing in the intent — structured selections, deterministic text
       * lookup, or semantic interpretation — resolved to the controlled
       * vocabulary, so there is nothing to retrieve against and nothing
       * meaningful to create. A user typing something unmappable is an
       * ordinary condition, not an exception, so it is reported as an
       * outcome. Map it to HTTP 422 at the API layer.
       *
       * Never stored in the idempotency store: no event was created, so a
       * retry should be free to resolve differently (e.g. once the caller
       * supplies an activity selection).
       */
      status: 'REJECTED';
      reason: 'NO_RESOLVABLE_ACTIVITY';
      semanticSource: SemanticSource | 'NONE';
    };

export interface RecommendationService {
  recommend(intent: RawIntent, userId?: UserId): Promise<RecommendationResult>;
}

export interface MatchingService {
  match(userId: UserId, intent: RawIntent): Promise<MatchOutcome>;
}

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

export type MetricName =
  | 'llm.calls'
  | 'llm.errors'
  | 'llm.latency_ms'
  | 'semantic.cache.hit'
  | 'semantic.cache.miss'
  | 'semantic.deterministic.hit'
  | 'recommendation.latency_ms'
  | 'recommendation.cache.hit'
  | 'recommendation.cache.miss'
  | 'recommendation.candidates'
  | 'match.latency_ms'
  | 'match.candidates'
  | 'match.score'
  | 'match.matched'
  | 'match.pending'
  | 'match.rejected'
  | 'match.join_conflict'
  | 'match.requests'
  | 'event.created'
  | 'suggestions.cache.hit'
  | 'suggestions.cache.miss';

export interface Metrics {
  increment(name: MetricName, value?: number): void;
  observe(name: MetricName, value: number): void;
}

// ---------------------------------------------------------------------------
// Taxonomy index (compiled form of the controlled vocabulary)
// ---------------------------------------------------------------------------

export type ActivityRelation =
  | 'EXACT'
  | 'PARENT'
  | 'CHILD'
  | 'SIBLING'
  | 'RELATED'
  | 'SAME_CATEGORY'
  | 'UNRELATED';

/**
 * Precomputed lookups over the controlled activity vocabulary. Built once at
 * engine construction, then read on every request — no allocation-heavy work
 * and no LLM calls behind any of these methods.
 */
export interface TaxonomyIndex {
  hasActivity(id: string): boolean;
  categoryOf(id: ActivityId): CategoryId | undefined;
  /** Canonical tags for an activity, including inherited parent tags. */
  tagsFor(id: ActivityId): string[];
  /** Alias/synonym lookup. Input must already be normalized text. */
  resolveSynonym(normalizedText: string): ActivityId | undefined;
  relation(a: ActivityId, b: ActivityId): ActivityRelation;
  /** Deterministic similarity in [0, 1] driven by `activitySimilarity` config. */
  similarity(a: ActivityId, b: ActivityId): number;
  /**
   * Widen intent activities into the activity + category ids worth querying
   * for in stage-1 retrieval (self, parent, children, siblings, related).
   */
  expand(activityIds: ActivityId[]): {
    activityIds: ActivityId[];
    categoryIds: CategoryId[];
  };
  allActivityIds(): ActivityId[];
}
