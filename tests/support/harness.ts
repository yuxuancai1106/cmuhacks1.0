/**
 * Shared fakes, spies and engine wiring for the **integration** suite.
 *
 * Separate from `factories.ts` (the unit suite's pure builders) so the exports
 * that suite already imports stay untouched. Everything here is a hand-written
 * fake — no mocking library — because the headline claim this suite exists to
 * prove is a *call count*, and a counted call has to be counted by something
 * we can read the source of.
 *
 * Nothing in this file imports a test framework, so it can be imported from
 * any test file without dragging vitest globals in.
 */
import type {
  AvailabilityService,
  CacheService,
  CandidateQuery,
  Clock,
  EventDraft,
  EventId,
  EventRepository,
  IdempotencyStore,
  JoinFailureReason,
  JoinResult,
  LlmClient,
  MatchOutcome,
  MatchableEvent,
  Metrics,
  RawIntent,
  UserId,
  UserProfile,
  UserProfileService,
} from '../../src/core/types.js';
import type { AlgorithmConfig } from '../../src/config/types.js';
import type { DeepPartial } from '../../src/config/defaults.js';
import type { MetricsSnapshot } from '../../src/observability/metrics.js';
import type { MatchingEngine } from '../../src/index.js';
import {
  createInMemoryEventRepository,
  createInMemoryMetrics,
  createMatchingEngine,
  createMemoryCache,
  fixedClock,
} from '../../src/index.js';
import { makeLocationService, NOW } from './factories.js';

export const MINUTE_MS = 60_000;

// ---------------------------------------------------------------------------
// Counting LLM client — the instrument the §A budget assertions read
// ---------------------------------------------------------------------------

/**
 * A semantically valid model response that maps onto the controlled
 * vocabulary, so a novel phrase resolves (and therefore gets cached) rather
 * than degrading to FALLBACK. `workout` is a real activity id; the validator
 * re-derives the category from the taxonomy regardless of what we claim here.
 */
export const VALID_SEMANTIC_RESPONSE = {
  canonicalActivity: 'workout',
  category: 'fitness',
  tags: ['sweat', 'cardio'],
  confidence: 0.9,
} as const;

export interface CountingLlmClient extends LlmClient {
  /** Every text handed to the model, in call order. Already normalized by the engine. */
  readonly calls: readonly string[];
  readonly callCount: number;
}

/**
 * Records every `extractSemantics` invocation. `respond` may return junk or
 * throw — the call is counted either way, which is exactly what the budget
 * assertions need (a failed call is still a call to the vendor).
 */
export function createCountingLlmClient(
  respond: (text: string) => unknown = () => VALID_SEMANTIC_RESPONSE,
): CountingLlmClient {
  const recorded: string[] = [];
  return {
    get calls(): readonly string[] {
      return recorded;
    },
    get callCount(): number {
      return recorded.length;
    },
    async extractSemantics(text: string): Promise<unknown> {
      recorded.push(text);
      return respond(text);
    },
  };
}

// ---------------------------------------------------------------------------
// Repository fakes
// ---------------------------------------------------------------------------

/** What `createInMemoryEventRepository` actually returns. */
export type InMemoryRepository = EventRepository & {
  all(): MatchableEvent[];
  insert(event: MatchableEvent): void;
};

export interface RepositoryCallLog {
  findCandidates: number;
  joinEventAtomically: number;
  createEvent: number;
}

export interface SpyRepository extends EventRepository {
  readonly calls: Readonly<RepositoryCallLog>;
  readonly totalCalls: number;
  /** Queries seen by `findCandidates`, in call order. */
  readonly queries: readonly CandidateQuery[];
  all(): MatchableEvent[];
}

/**
 * Counts every port method without changing behaviour. The read-only proof for
 * `recommend` is "`createEvent` and `joinEventAtomically` were never called" —
 * strictly stronger than comparing the store before and after, since a
 * create-then-delete would pass the latter.
 */
export function createSpyRepository(inner: InMemoryRepository): SpyRepository {
  const log: RepositoryCallLog = { findCandidates: 0, joinEventAtomically: 0, createEvent: 0 };
  const queries: CandidateQuery[] = [];

  return {
    get calls(): Readonly<RepositoryCallLog> {
      return log;
    },
    get totalCalls(): number {
      return log.findCandidates + log.joinEventAtomically + log.createEvent;
    },
    get queries(): readonly CandidateQuery[] {
      return queries;
    },
    async findCandidates(query: CandidateQuery): Promise<MatchableEvent[]> {
      log.findCandidates += 1;
      queries.push(query);
      return inner.findCandidates(query);
    },
    async joinEventAtomically(eventId: EventId, userId: UserId, now: Date): Promise<JoinResult> {
      log.joinEventAtomically += 1;
      return inner.joinEventAtomically(eventId, userId, now);
    },
    async createEvent(draft: EventDraft): Promise<MatchableEvent> {
      log.createEvent += 1;
      return inner.createEvent(draft);
    },
    all: () => inner.all(),
  };
}

export interface ConflictingJoinRepository extends EventRepository {
  /** Event ids `joinEventAtomically` was called with, in order. */
  readonly joinAttempts: readonly EventId[];
  all(): MatchableEvent[];
}

/**
 * Simulates the §24 race: a candidate that was joinable at retrieval time is
 * not joinable any more by the time the engine tries. The first `failures`
 * join attempts return `{ ok: false }`; everything after that delegates to the
 * real repository. `failures: Infinity` makes every candidate conflict.
 */
export function createConflictingJoinRepository(
  inner: InMemoryRepository,
  options: { failures: number; reason?: JoinFailureReason; mode?: 'fail' | 'throw' },
): ConflictingJoinRepository {
  const reason: JoinFailureReason = options.reason ?? 'FULL';
  const mode = options.mode ?? 'fail';
  const attempts: EventId[] = [];
  let failuresLeft = options.failures;

  return {
    get joinAttempts(): readonly EventId[] {
      return attempts;
    },
    findCandidates: (query) => inner.findCandidates(query),
    async joinEventAtomically(eventId: EventId, userId: UserId, now: Date): Promise<JoinResult> {
      attempts.push(eventId);
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        if (mode === 'throw') throw new Error('REPOSITORY_UNAVAILABLE');
        return { ok: false, reason };
      }
      return inner.joinEventAtomically(eventId, userId, now);
    },
    createEvent: (draft) => inner.createEvent(draft),
    all: () => inner.all(),
  };
}

// ---------------------------------------------------------------------------
// Failing / degraded ports (§30)
// ---------------------------------------------------------------------------

export function createThrowingCache(): CacheService {
  return {
    get<T>(): Promise<T | undefined> {
      return Promise.reject(new Error('CACHE_DOWN'));
    },
    set(): Promise<void> {
      return Promise.reject(new Error('CACHE_DOWN'));
    },
    delete(): Promise<void> {
      return Promise.reject(new Error('CACHE_DOWN'));
    },
  };
}

export function createProfileService(profile: UserProfile | null): UserProfileService {
  return { getProfile: () => Promise.resolve(profile) };
}

export function createThrowingProfileService(): UserProfileService {
  return { getProfile: () => Promise.reject(new Error('PROFILES_DOWN')) };
}

export function createThrowingIdempotencyStore(): IdempotencyStore {
  return {
    get: () => Promise.reject(new Error('IDEMPOTENCY_DOWN')),
    set: () => Promise.reject(new Error('IDEMPOTENCY_DOWN')),
  };
}

export function createThrowingAvailability(): AvailabilityService {
  return { getNextAvailableSlot: () => Promise.reject(new Error('AVAILABILITY_DOWN')) };
}

export function createFixedAvailability(slot: { startTime: Date; endTime: Date } | null): AvailabilityService {
  return { getNextAvailableSlot: () => Promise.resolve(slot) };
}

// ---------------------------------------------------------------------------
// Engine wiring
// ---------------------------------------------------------------------------

export type TestMetrics = Metrics & { snapshot(): MetricsSnapshot; reset(): void };
export type TestClock = Clock & { set(d: Date): void; advance(ms: number): void };

export interface HarnessOptions {
  /** Events pre-loaded into the default in-memory repository. */
  seed?: MatchableEvent[];
  /**
   * Wraps the seeded in-memory repository with a spy / fault-injecting
   * decorator. The engine then talks to the wrapper, while `harness.repo`
   * stays the underlying store — i.e. the assertions still read real state.
   */
  wrapEvents?: (inner: InMemoryRepository) => EventRepository;
  /** Response the counting LLM returns (or throws). Default: a valid `workout` interpretation. */
  llmResponse?: (text: string) => unknown;
  /** Substitute a different `LlmClient` entirely; `harness.llm` then counts nothing. */
  llmClient?: LlmClient;
  /** Wire the engine with no `LlmClient` at all — the parser keeps only its deterministic tier. */
  withoutLlm?: boolean;
  cache?: CacheService;
  profiles?: UserProfileService;
  availability?: AvailabilityService;
  idempotency?: IdempotencyStore;
  config?: DeepPartial<AlgorithmConfig>;
  now?: Date;
}

export interface EngineHarness {
  engine: MatchingEngine;
  /** The seeded in-memory store. Still the source of truth when `events` wraps it. */
  repo: InMemoryRepository;
  /** Meaningful unless `llmClient` was supplied. */
  llm: CountingLlmClient;
  metrics: TestMetrics;
  clock: TestClock;
  cache: CacheService;
  snapshot(): MetricsSnapshot;
  counter(name: keyof MetricsSnapshot['counters']): number;
}

/**
 * Builds a fully deterministic engine: frozen clock, in-memory metrics we can
 * read back, the synthetic `TEST_LOCATIONS` catalogue (so distances land in
 * known bands), and a counting LLM client.
 */
export function createHarness(options: HarnessOptions = {}): EngineHarness {
  const repo = createInMemoryEventRepository({ seed: options.seed });
  const llm = createCountingLlmClient(options.llmResponse);
  const metrics = createInMemoryMetrics();
  const clock = fixedClock(options.now ?? NOW);
  const cache = options.cache ?? createMemoryCache({ clock });

  const engine = createMatchingEngine({
    events: options.wrapEvents ? options.wrapEvents(repo) : repo,
    locations: makeLocationService(),
    cache,
    clock,
    metrics,
    llm: options.withoutLlm ? undefined : (options.llmClient ?? llm),
    profiles: options.profiles,
    availability: options.availability,
    idempotency: options.idempotency,
    config: options.config,
  });

  return {
    engine,
    repo,
    llm,
    metrics,
    clock,
    cache,
    snapshot: () => metrics.snapshot(),
    counter: (name) => metrics.snapshot().counters[name] ?? 0,
  };
}

export interface SpyEngineHarness extends EngineHarness {
  /** The decorator the engine actually talks to. `repo` remains the real store. */
  spy: SpyRepository;
}

/** A harness whose engine talks to the repository through a counting spy. */
export function createSpyHarness(options: Omit<HarnessOptions, 'wrapEvents'> = {}): SpyEngineHarness {
  let captured: SpyRepository | undefined;
  const harness = createHarness({
    ...options,
    wrapEvents: (inner) => {
      captured = createSpyRepository(inner);
      return captured;
    },
  });
  if (captured === undefined) throw new Error('spy repository was not installed');
  return { ...harness, spy: captured };
}

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

/**
 * A button-only intent that lines up exactly with `makeEvent()`: same
 * activity, same window, same location. Scores ~0.91 against it, comfortably
 * over the default 0.70 threshold.
 */
export function treadmillIntent(overrides: Partial<RawIntent> = {}): RawIntent {
  const base: RawIntent = {
    activityIds: ['treadmill'],
    locationIds: ['loc-a'],
    startTime: new Date(NOW.getTime() + 30 * MINUTE_MS),
    endTime: new Date(NOW.getTime() + 90 * MINUTE_MS),
  };
  return { ...base, ...overrides };
}

/**
 * Free text that provably cannot reach the controlled vocabulary through the
 * deterministic tier: no token is an activity id or a synonym, and none is
 * stripped to one by `normalizeText`/`tokenize`.
 */
export const NOVEL_TEXT_A = 'wanna sweat a bit before dinner';
export const NOVEL_TEXT_B = 'feeling restless, need to burn off some steam';
/** Text no tier can map — used where the required outcome is REJECTED / empty. */
export const UNMAPPABLE_TEXT = 'zzzz qqqq wibble';

// ---------------------------------------------------------------------------
// Outcome narrowing
// ---------------------------------------------------------------------------

export type MatchedOutcome = Extract<MatchOutcome, { status: 'MATCHED' }>;
export type PendingOutcome = Extract<MatchOutcome, { status: 'PENDING' }>;
export type RejectedOutcome = Extract<MatchOutcome, { status: 'REJECTED' }>;

function describe(outcome: MatchOutcome): string {
  return outcome.status === 'REJECTED' ? `REJECTED(${outcome.reason})` : outcome.status;
}

export function asMatched(outcome: MatchOutcome): MatchedOutcome {
  if (outcome.status !== 'MATCHED') throw new Error(`expected MATCHED, got ${describe(outcome)}`);
  return outcome;
}

export function asPending(outcome: MatchOutcome): PendingOutcome {
  if (outcome.status !== 'PENDING') throw new Error(`expected PENDING, got ${describe(outcome)}`);
  return outcome;
}

export function asRejected(outcome: MatchOutcome): RejectedOutcome {
  if (outcome.status !== 'REJECTED') throw new Error(`expected REJECTED, got ${describe(outcome)}`);
  return outcome;
}
