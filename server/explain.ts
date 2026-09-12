/**
 * server/explain.ts — read-only pipeline inspector behind `POST /api/explain`.
 *
 * This is the demo's hero visualization: it must show *exactly* what
 * `MatchingEngine.match()` would do, never an approximation of it. To keep
 * that promise structurally (not just by discipline) this module is built
 * entirely out of the library's own exported primitives —
 * `normalizeStructuredIntent`, `deterministicActivityFromText`, `resolveTime`,
 * `buildCandidateQuery`, `hardFilter`, `rankCandidates` — the exact same
 * functions `services/matching.ts` and `services/recommendation.ts` compose.
 * There is no parallel scoring/filtering logic here that could quietly drift
 * from the real thing.
 *
 * Two hard constraints, enforced by what this module does and does not do:
 *
 *  - **Read-only.** Only `EventRepository.findCandidates` is ever called.
 *    `joinEventAtomically` and `createEvent` are not imported, so nothing
 *    here can join, create, or otherwise mutate the store.
 *
 *  - **Zero LLM calls, ever.** This module never imports `SemanticParser`,
 *    `LlmClient`, or `createSemanticParser`, and never touches
 *    `engine`'s internal parser. Free text is resolved through
 *    `deterministicActivityFromText` only (the same deterministic tier
 *    `recommend()` uses) — exactly per the brief. Unmappable free text
 *    reports `semantic.source: 'NONE'` and the pipeline stops there, the
 *    same way `services/matching.ts` reports `REJECTED` when nothing
 *    resolves to a controlled-vocabulary activity. No model is ever
 *    consulted, no cache is read or written.
 *
 * One deliberate divergence from `match()`/`recommend()`, and why it's safe:
 * neither `excludeUserId` is passed to `buildCandidateQuery`. The real paths
 * pass it so the *repository* drops the caller's own/joined events before
 * `hardFilter` ever sees them — correct for a live request, but it would make
 * `OWN_EVENT` / `ALREADY_PARTICIPANT` invisible here, silently lowering
 * `retrieved` instead of appearing as a labelled rejection — exactly the
 * information this endpoint exists to surface. Omitting it only moves
 * *where* those events are excluded (query time -> hard-filter time); the
 * resulting `kept` / `ranked` / `decision` are identical to what `match()`
 * would produce for the same intent, for any candidate set under
 * `config.candidateLimit` (true for this demo's seed data). See the final
 * report for the one edge case where that stops being true (hitting the
 * retrieval cap with a different exclusion set).
 *
 * See the final report for two more findings about which `RejectionReason`s
 * can actually reach `stages.rejected` at all, given the real
 * `EventRepository` contract this demo runs against.
 */
import type {
  ActivityId,
  CandidateQuery,
  CategoryId,
  EventId,
  EventRepository,
  LocationId,
  LocationService,
  MatchableEvent,
  NormalizedIntent,
  RawIntent,
  RejectionReason,
  ScoreBreakdown,
  ScoredEvent,
  ScoringWeights,
  SemanticSource,
  TaxonomyIndex,
  TimeResolutionSource,
  UserId,
} from '../src/index.js';
import type { MatchingEngine } from '../src/index.js';
import {
  buildCandidateQuery,
  deterministicActivityFromText,
  hardFilter,
  normalizeStructuredIntent,
  normalizeText,
  rankCandidates,
  resolveTime,
  tokenize,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Wire types — the pinned `/api/explain` response shape (minus `metrics`,
// which the route handler attaches the same way `/api/recommend` does: from
// the server's own metrics snapshot, which this read-only module has no
// business owning).
// ---------------------------------------------------------------------------

export interface ExplainNormalized {
  activityIds: ActivityId[];
  categoryIds: CategoryId[];
  tags: string[];
  locationIds: LocationId[];
  startTime?: string;
  endTime?: string;
  /** Absent only when no activity resolved at all, so time was never resolved. */
  resolvedFrom?: TimeResolutionSource;
}

export interface ExplainSemantic {
  /**
   * This endpoint only ever produces `'DETERMINISTIC'` (a free-text term
   * resolved via the taxonomy/synonym table) or `'NONE'` (no free text, or a
   * button selection already decided the activity, or the text was
   * unmappable). `'CACHE'` / `'LLM'` / `'FALLBACK'` are part of the shared
   * `SemanticSource` type but are structurally unreachable here — this
   * module never calls the semantic cache or an LLM.
   */
  source: SemanticSource | 'NONE';
  matchedTerm?: string;
  canonicalActivity?: ActivityId;
}

export interface ExplainRejectedEvent {
  eventId: EventId;
  activityId: ActivityId;
  reason: RejectionReason;
}

export interface ExplainRankedEvent {
  eventId: EventId;
  activityId: ActivityId;
  locationId: LocationId;
  participantCount: number;
  capacity: number;
  startTime: string;
  score: number;
  aboveThreshold: boolean;
  breakdown: ScoreBreakdown;
}

/**
 * Why the indexed query never returned an event.
 *
 * These are *not* `RejectionReason`s. The repository filters status, expiry and
 * capacity in the database (spec 13/28), so those events never reach
 * `hardFilter` and can never appear in `rejected`. Surfacing them separately is
 * the only honest way to show the two-stage design: the database does the cheap
 * bulk elimination, and application code does the nuanced part.
 */
export type QueryExclusionReason =
  | 'NOT_OPEN'
  | 'EXPIRED'
  | 'FULL'
  | 'ACTIVITY_MISMATCH'
  | 'TIME_OUTSIDE_WINDOW'
  | 'LOCATION_MISMATCH';

export interface ExplainExcludedEvent {
  eventId: EventId;
  activityId: ActivityId;
  reason: QueryExclusionReason;
}

export interface ExplainStages {
  /** Total events in the store, when the caller supplies them. Demo-only. */
  total?: number;
  /**
   * Events the indexed query never returned, each with the documented
   * `CandidateQuery` predicate that excluded it. Present only when the caller
   * passes `allEvents` — a demo affordance, since a production repository would
   * not enumerate its whole table.
   */
  excludedByQuery?: ExplainExcludedEvent[];
  /** Count returned by `EventRepository.findCandidates`, before hard filtering. */
  retrieved: number;
  rejected: ExplainRejectedEvent[];
  /** `retrieved - rejected.length`. */
  kept: number;
  ranked: ExplainRankedEvent[];
}

export type ExplainDecisionKind = 'WOULD_JOIN' | 'WOULD_CREATE' | 'REJECTED';

export interface ExplainDecision {
  kind: ExplainDecisionKind;
  eventId: EventId | null;
  /** The top-ranked candidate's score, even when it's below threshold (WOULD_CREATE). `null` only when nothing was ranked at all. */
  score: number | null;
  threshold: number;
}

export interface ExplainResult {
  normalized: ExplainNormalized;
  semantic: ExplainSemantic;
  stages: ExplainStages;
  decision: ExplainDecision;
  weights: ScoringWeights;
}

export interface ExplainArgs {
  engine: MatchingEngine;
  events: EventRepository;
  locations: LocationService;
  intent: RawIntent;
  userId: UserId;
  now: Date;
  /**
   * Every event in the store. Demo-only: lets the inspector explain which
   * `CandidateQuery` predicate excluded each event the query did not return.
   * Omit it and `stages.total`/`stages.excludedByQuery` are simply absent.
   */
  allEvents?: MatchableEvent[];
}

// ---------------------------------------------------------------------------
// Deterministic-only semantic step (mirrors `withDeterministicText` in
// `src/services/recommendation.ts`, minus everything that module intentionally
// cannot do — LLM, cache).
// ---------------------------------------------------------------------------

interface DeterministicSemanticResult {
  source: SemanticSource | 'NONE';
  matchedTerm?: string;
  canonicalActivity?: ActivityId;
}

/**
 * Re-derives *which term* produced `deterministicActivityFromText`'s answer,
 * for display only. This replays that function's own documented precedence
 * (whole normalized text as an id, then as a synonym, then the longest
 * matching token, leftmost breaking ties) using the exact same exported
 * primitives it is built from (`normalizeText`, `tokenize`,
 * `taxonomy.hasActivity`, `taxonomy.resolveSynonym`) — see
 * `src/core/normalize.ts`, which documents this same duplication as the
 * accepted pattern in this codebase (its parser-side twin,
 * `src/semantic/parser.ts`'s `bestTokenMatch`, exists for the identical
 * reason: neither helper is exported on its own). The activity id used for
 * every downstream decision always comes from the real
 * `deterministicActivityFromText` call in `resolveSemantic` below, never from
 * this helper — this only supplies the human-readable term.
 */
function findMatchedTerm(text: string, taxonomy: TaxonomyIndex): string | undefined {
  const normalized = normalizeText(text);
  if (normalized.length === 0) return undefined;

  if (taxonomy.hasActivity(normalized)) return normalized;
  if (taxonomy.resolveSynonym(normalized) !== undefined) return normalized;

  let winner: { token: string; tokenLength: number } | undefined;
  for (const token of tokenize(normalized)) {
    const match = taxonomy.hasActivity(token) ? token : taxonomy.resolveSynonym(token);
    if (match === undefined) continue;
    if (winner === undefined || token.length > winner.tokenLength) {
      winner = { token, tokenLength: token.length };
    }
  }
  return winner?.token;
}

/**
 * The deterministic-only counterpart of `mergeSemantic` in
 * `src/services/matching.ts`: a structured (button) selection always wins,
 * and free text is only ever consulted through the zero-LLM tier. Reports
 * `'NONE'` — never `'FALLBACK'` — for unmappable text, because `'FALLBACK'`
 * in the real engine specifically means "an LLM was configured and failed";
 * no LLM is ever consulted here, so that source would be a lie.
 */
function resolveSemantic(
  structured: NormalizedIntent,
  taxonomy: TaxonomyIndex,
): DeterministicSemanticResult {
  if (structured.activityIds.length > 0) return { source: 'NONE' };
  if (structured.sourceText === undefined) return { source: 'NONE' };

  const activityId = deterministicActivityFromText(structured.sourceText, taxonomy);
  if (activityId === undefined) return { source: 'NONE' };

  const matchedTerm = findMatchedTerm(structured.sourceText, taxonomy) ?? activityId;
  return { source: 'DETERMINISTIC', matchedTerm, canonicalActivity: activityId };
}

function applySemantic(
  structured: NormalizedIntent,
  semantic: DeterministicSemanticResult,
  taxonomy: TaxonomyIndex,
): NormalizedIntent {
  if (semantic.source !== 'DETERMINISTIC' || semantic.canonicalActivity === undefined) {
    return structured;
  }
  const activityId = semantic.canonicalActivity;
  const categoryId = taxonomy.categoryOf(activityId);
  return {
    ...structured,
    activityIds: [activityId],
    categoryIds: categoryId === undefined ? [] : [categoryId],
    tags: taxonomy.tagsFor(activityId),
  };
}

// ---------------------------------------------------------------------------
// Wire shaping
// ---------------------------------------------------------------------------

function toWireNormalized(
  intent: NormalizedIntent,
  resolvedFrom: TimeResolutionSource | undefined,
): ExplainNormalized {
  return {
    activityIds: intent.activityIds,
    categoryIds: intent.categoryIds,
    tags: intent.tags,
    locationIds: intent.locationIds,
    startTime: intent.startTime?.toISOString(),
    endTime: intent.endTime?.toISOString(),
    resolvedFrom,
  };
}

function toWireSemantic(semantic: DeterministicSemanticResult): ExplainSemantic {
  return {
    source: semantic.source,
    matchedTerm: semantic.matchedTerm,
    canonicalActivity: semantic.canonicalActivity,
  };
}

function toWireRanked(threshold: number, scored: ScoredEvent): ExplainRankedEvent {
  return {
    eventId: scored.event.id,
    activityId: scored.event.activityId,
    locationId: scored.event.locationId,
    participantCount: scored.event.participantCount,
    capacity: scored.event.capacity,
    startTime: scored.event.startTime.toISOString(),
    score: scored.score,
    aboveThreshold: scored.score >= threshold,
    breakdown: scored.breakdown,
  };
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/**
 * Evaluate the predicates `CandidateQuery` documents as the repository's
 * responsibility, in the order the contract lists them, and report the first
 * one an event fails.
 *
 * This deliberately mirrors the *contract* rather than any one repository's
 * code: `CandidateQuery` in `src/core/types.ts` states that implementations
 * MUST enforce status, `expiresAt > now` and capacity, and match on
 * activity-or-category, window intersection and location. If a repository
 * disagrees with this, the repository is wrong.
 */
function explainQueryExclusion(
  event: MatchableEvent,
  query: CandidateQuery,
): QueryExclusionReason {
  if (event.status !== 'OPEN') return 'NOT_OPEN';
  if (event.expiresAt <= query.now) return 'EXPIRED';
  if (event.participantCount >= event.capacity) return 'FULL';

  const activityMatch =
    query.activityIds.includes(event.activityId) || query.categoryIds.includes(event.categoryId);
  if (!activityMatch) return 'ACTIVITY_MISMATCH';

  const intersects =
    event.startTime.getTime() < query.windowEnd.getTime() &&
    event.endTime.getTime() > query.windowStart.getTime();
  if (!intersects) return 'TIME_OUTSIDE_WINDOW';

  return 'LOCATION_MISMATCH';
}

export async function explainIntent(args: ExplainArgs): Promise<ExplainResult> {
  const { engine, events, locations, intent, userId, now } = args;
  const { taxonomy, config } = engine;

  // --- 1. Structured normalization (buttons, explicit locations) ----------
  const structured = normalizeStructuredIntent({ intent, taxonomy, locations, config });

  // --- 2. Deterministic-only semantic step, then merge (§3 in the brief) ---
  const semantic = resolveSemantic(structured, taxonomy);
  const merged = applySemantic(structured, semantic, taxonomy);

  const activityId = merged.activityIds[0];

  // Nothing in the intent — button, deterministic text, or otherwise —
  // resolved to the controlled vocabulary. Mirrors `MatchingService.match`'s
  // own short-circuit in `src/services/matching.ts`: stop before ever
  // touching the repository, since `buildCandidateQuery` would expand an
  // empty activity list into a query that provably retrieves nothing useful.
  if (activityId === undefined) {
    return {
      normalized: toWireNormalized(merged, undefined),
      semantic: toWireSemantic(semantic),
      stages: {
        ...(args.allEvents !== undefined
          ? { total: args.allEvents.length, excludedByQuery: [] }
          : {}),
        retrieved: 0,
        rejected: [],
        kept: 0,
        ranked: [],
      },
      decision: { kind: 'REJECTED', eventId: null, score: null, threshold: config.matchThreshold },
      weights: config.weights,
    };
  }

  // --- 3. Time resolution ---------------------------------------------------
  // Always accepted, including a `DEFAULT_FALLBACK` window — unlike
  // `recommend()`'s advisory path (which deliberately discards a fallback
  // window to keep `timeScore` neutral), this mirrors `match()`, which always
  // resolves and uses a real window before retrieving. That's the honest
  // choice for a panel whose whole job is showing what actually happens: a
  // silently-discarded fallback would hide *why* a same-day event two hours
  // out reads as `TIME_INCOMPATIBLE`.
  //
  // No `AvailabilityService` is threaded through this read-only inspector's
  // pinned signature, so case 3 of `resolveTime` degrades straight to
  // `DEFAULT_FALLBACK` here exactly like the real engine does whenever no
  // availability service is configured — not a gap specific to this module.
  const resolvedTime = await resolveTime({
    explicitStart: intent.startTime,
    explicitEnd: intent.endTime,
    normalizedText: merged.sourceText,
    activityId,
    explicitDurationMinutes: intent.durationMinutes,
    userId,
    config,
    now,
  });

  const normalized: NormalizedIntent = {
    ...merged,
    startTime: resolvedTime.startTime,
    endTime: resolvedTime.endTime,
  };

  // --- 4. Retrieve (see the file doc comment re: omitting `excludeUserId`) -
  const query = buildCandidateQuery({ intent: normalized, taxonomy, config, now });
  const retrieved: MatchableEvent[] = await events.findCandidates(query);

  // --- 5. Hard filter ---------------------------------------------------------
  const { kept, rejected } = hardFilter({
    intent: normalized,
    events: retrieved,
    deps: { taxonomy, locations, config },
    now,
    userId,
  });

  // --- 6. Rank ----------------------------------------------------------------
  const ranked = rankCandidates(normalized, kept, { taxonomy, locations, config }, now);

  // --- 7. Decision — a prediction, mirroring the threshold rule
  // `tryJoinRanked` actually applies in `src/services/matching.ts`. This never
  // calls `joinEventAtomically`: nothing here can act on the prediction.
  const top = ranked[0];
  const decision: ExplainDecision =
    top !== undefined && top.score >= config.matchThreshold
      ? {
          kind: 'WOULD_JOIN',
          eventId: top.event.id,
          score: top.score,
          threshold: config.matchThreshold,
        }
      : {
          kind: 'WOULD_CREATE',
          eventId: null,
          score: top?.score ?? null,
          threshold: config.matchThreshold,
        };

  const retrievedById = new Map(retrieved.map((event) => [event.id, event]));

  const excludedByQuery = args.allEvents?.filter((e) => !retrievedById.has(e.id)).map((e) => ({
    eventId: e.id,
    activityId: e.activityId,
    reason: explainQueryExclusion(e, query),
  }));

  return {
    normalized: toWireNormalized(normalized, resolvedTime.source),
    semantic: toWireSemantic(semantic),
    stages: {
      ...(args.allEvents !== undefined ? { total: args.allEvents.length } : {}),
      ...(excludedByQuery !== undefined ? { excludedByQuery } : {}),
      retrieved: retrieved.length,
      rejected: rejected.map(({ eventId, reason }) => {
        const event = retrievedById.get(eventId);
        // Invariant: `hardFilter` only ever rejects events from the exact
        // `retrieved` array passed to it above, so this can never miss.
        if (event === undefined) {
          throw new Error(`explainIntent: rejected event ${eventId} missing from retrieved set`);
        }
        return { eventId, activityId: event.activityId, reason };
      }),
      kept: kept.length,
      ranked: ranked.map((scored) => toWireRanked(config.matchThreshold, scored)),
    },
    decision,
    weights: config.weights,
  };
}
