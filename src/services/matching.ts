/**
 * §23-§27 (+ §26 idempotency, §30 graceful degradation) — the authoritative
 * matching path.
 *
 * This is the only path that writes. An LLM may participate here, but *only*
 * as a semantic parser: it turns "wanna sweat a bit before dinner" into a
 * controlled-vocabulary activity id and some tags. Every decision that follows
 * — which candidates to retrieve, how they score, which one clears the
 * threshold, whether a join actually succeeded, whether to create an event —
 * is deterministic code plus a transactional repository call. The LLM never
 * sees an event, a distance, a capacity or an expiry.
 *
 * Order of operations (pinned in API.md):
 *   1. idempotent replay
 *   2. authoritative profile lookup
 *   3. semantic parse + merge with structured selections
 *   4. time resolution
 *   5. location resolution
 *   6. retrieve -> hard filter -> rank
 *   7. transactional join loop over everything at/above threshold
 *   8. otherwise create
 *   9. store the outcome under the idempotency key
 */
import type {
  ActivityId,
  AvailabilityService,
  CategoryId,
  Clock,
  EventDraft,
  EventRepository,
  IdempotencyStore,
  LocationId,
  LocationService,
  MatchOutcome,
  MatchableEvent,
  Metrics,
  MatchingService,
  NormalizedIntent,
  RawIntent,
  ScoredEvent,
  SemanticInterpretation,
  SemanticParser,
  SemanticSource,
  TaxonomyIndex,
  UserId,
  UserProfile,
  UserProfileService,
} from '../core/types.js';
import type { AlgorithmConfig } from '../config/types.js';
import { normalizeStructuredIntent } from '../core/normalize.js';
import { buildCandidateQuery } from '../retrieval/candidates.js';
import { hardFilter } from '../retrieval/hardFilters.js';
import { rankCandidates } from '../scoring/score.js';
import { resolveTime } from '../time/resolve.js';

export interface MatchingServiceDeps {
  events: EventRepository;
  taxonomy: TaxonomyIndex;
  locations: LocationService;
  config: AlgorithmConfig;
  clock: Clock;
  metrics: Metrics;
  /**
   * Optional. When absent, free text contributes nothing beyond the structured
   * normalization (and the deterministic relative-time parse) and
   * `semanticSource` is `'NONE'`. `createMatchingEngine` always supplies one —
   * a parser with no `LlmClient` still resolves the deterministic tier, which
   * is what keeps the LLM-call ratio near zero.
   */
  parser?: SemanticParser;
  profiles?: UserProfileService;
  availability?: AvailabilityService;
  idempotency?: IdempotencyStore;
}

/**
 * Placeholder location for an event created by a user who named no location,
 * has no device coordinates and no home location on their profile.
 *
 * `EventDraft.locationId` is non-optional, so *something* must be written. A
 * sentinel outside the canonical catalogue is the honest choice: it is not a
 * real place, `LocationService.getLocation` returns undefined for it, and
 * `locationCompatibility` therefore scores it as `config.location.far` for
 * anyone who *did* name a location — while users who named no location are
 * unaffected (an empty intent location list scores 1.0 by definition). The
 * alternative — silently pinning the event to some arbitrary campus building —
 * would assert a fact about the world that nobody supplied.
 */
export const UNSPECIFIED_LOCATION_ID = 'unspecified';

const MS_PER_MINUTE = 60_000;

export function createMatchingService(deps: MatchingServiceDeps): MatchingService {
  const {
    events,
    taxonomy,
    locations,
    config,
    clock,
    metrics,
    parser,
    profiles,
    availability,
    idempotency,
  } = deps;

  async function match(userId: UserId, intent: RawIntent): Promise<MatchOutcome> {
    // Counted once per call, including replays: `llmCallRatio` is
    // "LLM calls per match request", and a replayed request really was a
    // request the engine served without one.
    metrics.increment('match.requests');
    const startedAtMs = Date.now();
    const now = clock.now();

    try {
      // --- 1. Idempotent replay (§26) ----------------------------------
      const replay = await loadReplay(idempotency, userId, intent.idempotencyKey);
      if (replay !== undefined) return replay;

      // --- 2. Authoritative profile (never from the client) -------------
      const profile = await loadProfile(profiles, userId);

      // --- 3. Semantic parse + merge (§23) ------------------------------
      const structured = normalizeStructuredIntent({ intent, taxonomy, locations, config });
      const parsed = await runSemanticParser(parser, structured.sourceText);
      const merged = mergeSemantic(structured, parsed.interpretation, taxonomy);
      const semanticSource = parsed.source;

      // No controlled-vocabulary activity survived structured validation, the
      // deterministic text layer, or semantic interpretation. Stop here rather
      // than issuing a retrieval query that provably cannot match anything
      // (`buildCandidateQuery` expands an empty activity list into an empty
      // query) and rather than writing an event that no future query could
      // ever retrieve. Not stored in the idempotency store — see REJECTED.
      const activityId = merged.activityIds[0];
      if (activityId === undefined) {
        metrics.increment('match.rejected');
        return { status: 'REJECTED', reason: 'NO_RESOLVABLE_ACTIVITY', semanticSource };
      }

      // --- 4. Time (§24) -------------------------------------------------
      const resolvedTime = await resolveTime({
        explicitStart: intent.startTime,
        explicitEnd: intent.endTime,
        normalizedText: merged.sourceText,
        activityId,
        explicitDurationMinutes: intent.durationMinutes,
        userId,
        availability,
        config,
        now,
      });

      // --- 5. Location ---------------------------------------------------
      const locationIds = withProfileHomeLocation(merged.locationIds, profile, locations);

      const normalized: NormalizedIntent = {
        ...merged,
        locationIds,
        startTime: resolvedTime.startTime,
        endTime: resolvedTime.endTime,
      };

      // --- 6. Retrieve -> hard filter -> rank (§25) ----------------------
      const query = buildCandidateQuery({
        intent: normalized,
        taxonomy,
        config,
        now,
        excludeUserId: userId,
      });
      const candidates: MatchableEvent[] = await events.findCandidates(query);
      metrics.observe('match.candidates', candidates.length);

      const { kept } = hardFilter({
        intent: normalized,
        events: candidates,
        deps: { taxonomy, locations, config },
        now,
        userId,
      });
      const ranked = rankCandidates(normalized, kept, { taxonomy, locations, config }, now);

      // --- 7. Transactional join (§25) -----------------------------------
      const joined = await tryJoinRanked(ranked, userId, now);
      if (joined !== undefined) {
        metrics.observe('match.score', joined.scored.score);
        metrics.increment('match.matched');
        const outcome: MatchOutcome = {
          status: 'MATCHED',
          eventId: joined.event.id,
          score: joined.scored.score,
          breakdown: joined.scored.breakdown,
          // The repository's post-join row, not the pre-join candidate: it is
          // the only authoritative view of participantCount/status.
          event: joined.event,
          semanticSource,
        };
        await storeOutcome(idempotency, userId, intent.idempotencyKey, outcome);
        return outcome;
      }

      // --- 8. Create (§27) -----------------------------------------------
      const bestScore = ranked[0]?.score;
      if (bestScore !== undefined) metrics.observe('match.score', bestScore);

      const created = await events.createEvent(
        buildDraft({ userId, activityId, intent: normalized, config, now, taxonomy }),
      );
      metrics.increment('event.created');
      metrics.increment('match.pending');

      const outcome: MatchOutcome = {
        status: 'PENDING',
        eventId: created.id,
        event: created,
        bestRejectedScore: bestScore,
        semanticSource,
      };
      await storeOutcome(idempotency, userId, intent.idempotencyKey, outcome);
      return outcome;
    } finally {
      metrics.observe('match.latency_ms', Date.now() - startedAtMs);
    }
  }

  /**
   * Walk the ranked candidates in order and attempt an atomic join on every
   * one that is at or above `config.matchThreshold`, stopping at the first
   * success.
   *
   * A cached or previously-retrieved candidate is **never** proof that it can
   * be joined: between retrieval and this instant another request may have
   * filled it, closed it, or expired it. `joinEventAtomically` is the single
   * source of truth, and only its `ok: true` produces a MATCHED outcome.
   *
   * Every failure — including `ALREADY_PARTICIPANT`, which is a skip and not a
   * match — increments `match.join_conflict` and moves to the next candidate.
   * Exhausting the above-threshold list falls through to event creation.
   *
   * Because `rankCandidates` sorts descending, the first sub-threshold entry
   * ends the scan.
   */
  async function tryJoinRanked(
    ranked: ScoredEvent[],
    userId: UserId,
    now: Date,
  ): Promise<{ scored: ScoredEvent; event: MatchableEvent } | undefined> {
    for (const scored of ranked) {
      if (scored.score < config.matchThreshold) break;

      let ok: MatchableEvent | undefined;
      try {
        const result = await events.joinEventAtomically(scored.event.id, userId, now);
        if (result.ok) ok = result.event;
      } catch {
        // A repository error mid-loop is treated exactly like a lost race:
        // record the conflict and try the next candidate rather than failing
        // the whole request (§30). A total outage still surfaces, because the
        // fall-through `createEvent` will raise it.
        ok = undefined;
      }
      if (ok !== undefined) return { scored, event: ok };

      metrics.increment('match.join_conflict');
    }
    return undefined;
  }

  return { match };
}

// ---------------------------------------------------------------------------
// Steps 1-3 helpers
// ---------------------------------------------------------------------------

/** An idempotency-store outage degrades to "no replay" rather than failing (§30). */
async function loadReplay(
  idempotency: IdempotencyStore | undefined,
  userId: UserId,
  key: string | undefined,
): Promise<MatchOutcome | undefined> {
  if (idempotency === undefined || key === undefined) return undefined;
  let stored: MatchOutcome | undefined;
  try {
    stored = await idempotency.get(userId, key);
  } catch {
    return undefined;
  }
  if (stored === undefined) return undefined;
  // A REJECTED outcome is never stored (nothing was created, so a retry should
  // be free to resolve differently), but guard anyway rather than widening the
  // variant with a field that has no meaning for it.
  if (stored.status === 'REJECTED') return undefined;
  return { ...stored, idempotentReplay: true };
}

async function storeOutcome(
  idempotency: IdempotencyStore | undefined,
  userId: UserId,
  key: string | undefined,
  outcome: MatchOutcome,
): Promise<void> {
  if (idempotency === undefined || key === undefined) return;
  // Only outcomes that produced durable state are worth replaying.
  if (outcome.status === 'REJECTED') return;
  try {
    await idempotency.set(userId, key, outcome);
  } catch {
    // Best effort: failing to record a replay token must not undo a join that
    // has already committed.
  }
}

/**
 * Profile data is authoritative and comes only from the `UserProfileService` —
 * `RawIntent` carries no profile fields and none would be believed. A profile
 * outage degrades to "no profile" (§30): the match still runs on the
 * structured intent.
 */
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

/**
 * The parser already implements deterministic -> cache -> LLM internally and
 * promises never to throw. The try/catch is belt-and-braces for a
 * custom/injected parser that breaks that promise: an LLM outage must degrade
 * the match, never fail it (§30).
 */
async function runSemanticParser(
  parser: SemanticParser | undefined,
  sourceText: string | undefined,
): Promise<{ interpretation: SemanticInterpretation | null; source: SemanticSource | 'NONE' }> {
  if (parser === undefined || sourceText === undefined) {
    return { interpretation: null, source: 'NONE' };
  }
  try {
    const result = await parser.parse(sourceText);
    return { interpretation: result.interpretation, source: result.source };
  } catch {
    return { interpretation: null, source: 'FALLBACK' };
  }
}

/**
 * ## The merge rule
 *
 * **Structured activity selections beat the semantic interpretation on
 * conflict. Tags are unioned.**
 *
 * Rationale: a button press is an unambiguous statement of intent; a semantic
 * interpretation is an inference from ambiguous prose, and may carry LLM
 * confidence below 1.0. If a user taps "basketball" and also types "or maybe a
 * run", the taps decide the activity. What the prose *can* still contribute is
 * colour — its tags are merged in, which raises `tagScore` against events that
 * share that flavour without ever changing which activity we search for.
 *
 * When there is no structured selection, the semantic interpretation supplies
 * the activity, its taxonomy-derived category, and the union of the taxonomy's
 * canonical tags for that activity with the model's own tags. `categoryIds`
 * always comes from the taxonomy, never from the model — the schema validator
 * already discards a model-claimed category that disagrees with the vocabulary.
 */
function mergeSemantic(
  structured: NormalizedIntent,
  interpretation: SemanticInterpretation | null,
  taxonomy: TaxonomyIndex,
): NormalizedIntent {
  if (interpretation === null) return structured;

  if (structured.activityIds.length > 0) {
    return { ...structured, tags: union(structured.tags, interpretation.tags) };
  }

  const activityId = interpretation.canonicalActivity;
  const categoryId = taxonomy.categoryOf(activityId) ?? interpretation.category;
  return {
    ...structured,
    activityIds: [activityId],
    categoryIds: [categoryId],
    tags: union(taxonomy.tagsFor(activityId), interpretation.tags),
  };
}

/**
 * Location precedence: explicit ids -> device coordinates (both already applied
 * by `normalizeStructuredIntent`) -> the profile's home location -> none.
 * A home location the `LocationService` does not recognize is ignored, exactly
 * like an unrecognized client-supplied id. "None" is a valid answer: it means
 * "no location constraint", which `locationCompatibility` scores as 1.0.
 */
function withProfileHomeLocation(
  locationIds: LocationId[],
  profile: UserProfile | null,
  locations: LocationService,
): LocationId[] {
  if (locationIds.length > 0) return locationIds;
  const home = profile?.homeLocationId;
  if (home === undefined) return locationIds;
  return locations.getLocation(home) === undefined ? locationIds : [home];
}

// ---------------------------------------------------------------------------
// Step 8 helper
// ---------------------------------------------------------------------------

/**
 * Builds the `EventDraft` for §27. The creator is enrolled by the repository
 * (`createEvent` inserts the event row and the creator's participant row in one
 * transaction), so the new event is immediately discoverable by the very next
 * `findCandidates` — with `participantCount: 1`, never as an OPEN event with
 * zero recorded participants.
 *
 * **Expiry rule:** `expiresAt = min(createdAt + defaultEventTtlMinutes, endTime)`.
 * The TTL bounds how long we keep *matching* into the event; the end time
 * bounds when the activity is actually over. Letting matching outlive the
 * activity would enroll someone into something that has already finished, so
 * the earlier of the two always wins.
 *
 * Edge case, documented deliberately: if the caller supplied an explicit time
 * window that has already ended, `endTime <= now` and the created event is born
 * expired — invisible to retrieval. That is consistent with the rest of the
 * engine (`hardFilter` rejects `endTime <= now` and `timeScore` returns 0 for
 * it), so a past-time intent could not have matched anything either. Rejecting
 * past windows is input validation and belongs to the app layer.
 */
function buildDraft(args: {
  userId: UserId;
  activityId: ActivityId;
  intent: NormalizedIntent;
  config: AlgorithmConfig;
  now: Date;
  taxonomy: TaxonomyIndex;
}): EventDraft {
  const { userId, activityId, intent, config, now, taxonomy } = args;

  const startTime = intent.startTime ?? now;
  const endTime =
    intent.endTime ?? new Date(startTime.getTime() + config.defaultDurationMinutes * MS_PER_MINUTE);

  const ttlExpiresAtMs = now.getTime() + config.defaultEventTtlMinutes * MS_PER_MINUTE;
  const expiresAt = new Date(Math.min(ttlExpiresAtMs, endTime.getTime()));

  const categoryId: CategoryId = taxonomy.categoryOf(activityId) ?? intent.categoryIds[0] ?? '';
  const tags = union(taxonomy.tagsFor(activityId), intent.tags);

  return {
    creatorId: userId,
    activityId,
    categoryId,
    tags,
    startTime,
    endTime,
    locationId: intent.locationIds[0] ?? UNSPECIFIED_LOCATION_ID,
    capacity: config.defaultEventCapacity,
    status: 'OPEN',
    createdAt: now,
    expiresAt,
  };
}

/** Order-preserving set union: `a`'s order first, then `b`'s new entries. */
function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}
