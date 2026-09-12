/**
 * server/seed.ts — believable demo data for the in-memory event repository.
 *
 * Every event below exists to make some part of the pipeline visible in
 * `/api/explain`'s funnel. What each one demonstrates:
 *
 *  - `evt-treadmill-1`, `evt-treadmill-2`, `evt-running-1`, `evt-workout-1` —
 *    fitness events at different start times, locations, and fill levels, so
 *    a treadmill/workout/gym query has several real candidates to *rank*
 *    rather than one obvious winner.
 *  - `evt-full-1` — `participantCount === capacity` (6/6), for `FULL`.
 *  - `evt-time-incompatible-1` — starts ~2h50m out, so it's within the
 *    candidate-retrieval window but more than `time.maxToleranceMinutes`
 *    (90min, default config) from a near-term request, for `TIME_INCOMPATIBLE`.
 *  - `evt-expired-1` — `expiresAt` in the past, for `EXPIRED`.
 *  - `evt-own-alice` / `evt-own-bob` / `evt-own-carol` / `evt-own-dan` — one
 *    fitness event created by each demo user, for `OWN_EVENT` when
 *    `/api/explain` is called as that user.
 *  - `evt-already-participant-alice` — created by `staff`, with `alice`
 *    already enrolled as a participant, for `ALREADY_PARTICIPANT` (a bonus
 *    rejection reason beyond the brief's explicit list).
 *  - `evt-coding-1`, `evt-art-1`, `evt-study-1`, `evt-social-1` — one event
 *    per remaining taxonomy category, so category-based retrieval/filtering
 *    is visible even outside the fitness cluster above.
 *
 * IMPORTANT caveat, expanded on in the final report: `evt-full-1` and
 * `evt-expired-1` can never actually appear in `/api/explain`'s
 * `stages.rejected`. `InMemoryEventRepository.findCandidates` (src/adapters/
 * inMemoryEventRepository.ts) unconditionally enforces `status === 'OPEN'`,
 * `expiresAt > now`, and `participantCount < capacity` *before* any event
 * reaches `hardFilter` — exactly per `EventRepository`'s documented contract.
 * So a full or expired event is simply absent from `stages.retrieved`; the
 * corresponding `hardFilter` branches (`FULL`, `EXPIRED`, and `NOT_OPEN`,
 * which nothing here exercises either) only ever fire for a caller that hands
 * `hardFilter` a stale/cached candidate list, which this read-only endpoint
 * never does. Both events are still seeded — for `/api/events` inspection,
 * and because the brief asks for them explicitly — but the funnel will just
 * show a lower `retrieved` count, not a labelled rejection, whenever they'd
 * otherwise have matched a query.
 *
 * Tags and category ids are derived from the real, compiled taxonomy rather
 * than hand-copied, so they can never drift from what a genuinely created
 * event would carry.
 */
import type { ActivityId, CategoryId, LocationId, MatchableEvent, UserId } from '../src/index.js';
import { DEFAULT_CONFIG, DEFAULT_TAXONOMY, buildTaxonomyIndex } from '../src/index.js';

const taxonomy = buildTaxonomyIndex(DEFAULT_TAXONOMY, DEFAULT_CONFIG);

function tagsFor(activityId: ActivityId): string[] {
  return taxonomy.tagsFor(activityId);
}

function categoryFor(activityId: ActivityId): CategoryId {
  const categoryId = taxonomy.categoryOf(activityId);
  if (categoryId === undefined) {
    throw new Error(`seedEvents: "${activityId}" is not in DEFAULT_TAXONOMY`);
  }
  return categoryId;
}

function minutesFrom(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

interface SeedEventInput {
  id: string;
  activityId: ActivityId;
  creatorId: UserId;
  locationId: LocationId;
  /** Minutes from `now`; may be negative for an already-past event. */
  startOffsetMinutes: number;
  durationMinutes: number;
  capacity: number;
  participantCount: number;
  participantIds?: UserId[];
  /** Minutes from `now`; defaults to -10 (created a little while ago). */
  createdOffsetMinutes?: number;
  /**
   * Minutes from `now`; defaults to the event's own end time (matching
   * closes when the activity is over). Only `evt-expired-1` overrides this
   * with a negative offset to land in the past.
   */
  expiresOffsetMinutes?: number;
}

function buildEvent(now: Date, input: SeedEventInput): MatchableEvent {
  const startTime = minutesFrom(now, input.startOffsetMinutes);
  const endTime = minutesFrom(now, input.startOffsetMinutes + input.durationMinutes);
  const expiresAt =
    input.expiresOffsetMinutes === undefined ? endTime : minutesFrom(now, input.expiresOffsetMinutes);

  return {
    id: input.id,
    creatorId: input.creatorId,
    status: 'OPEN',
    activityId: input.activityId,
    categoryId: categoryFor(input.activityId),
    tags: tagsFor(input.activityId),
    startTime,
    endTime,
    locationId: input.locationId,
    capacity: input.capacity,
    participantCount: input.participantCount,
    participantIds: input.participantIds,
    createdAt: minutesFrom(now, input.createdOffsetMinutes ?? -10),
    expiresAt,
  };
}

export function seedEvents(now: Date): MatchableEvent[] {
  return [
    // --- Fitness ranking cluster ------------------------------------------
    buildEvent(now, {
      id: 'evt-treadmill-1',
      activityId: 'treadmill',
      creatorId: 'staff',
      locationId: 'cohon-university-center',
      startOffsetMinutes: 20,
      durationMinutes: 45,
      capacity: 6,
      participantCount: 3,
      createdOffsetMinutes: -10,
    }),
    buildEvent(now, {
      id: 'evt-treadmill-2',
      activityId: 'treadmill',
      creatorId: 'staff',
      locationId: 'gesling-stadium',
      startOffsetMinutes: 55,
      durationMinutes: 45,
      capacity: 6,
      participantCount: 5,
      createdOffsetMinutes: -25,
    }),
    buildEvent(now, {
      id: 'evt-running-1',
      activityId: 'running',
      creatorId: 'staff',
      locationId: 'schenley-park',
      startOffsetMinutes: 25,
      durationMinutes: 40,
      capacity: 4,
      participantCount: 1,
      createdOffsetMinutes: -8,
    }),
    buildEvent(now, {
      id: 'evt-workout-1',
      activityId: 'workout',
      creatorId: 'staff',
      locationId: 'tepper-building',
      startOffsetMinutes: 35,
      durationMinutes: 60,
      capacity: 8,
      participantCount: 2,
      createdOffsetMinutes: -15,
    }),

    // --- Rejection-reason demos --------------------------------------------
    buildEvent(now, {
      id: 'evt-full-1',
      activityId: 'treadmill',
      creatorId: 'staff',
      locationId: 'cohon-university-center',
      startOffsetMinutes: 30,
      durationMinutes: 45,
      capacity: 6,
      participantCount: 6, // === capacity -> FULL (see file doc comment)
      createdOffsetMinutes: -30,
    }),
    buildEvent(now, {
      id: 'evt-time-incompatible-1',
      activityId: 'workout',
      creatorId: 'staff',
      locationId: 'wean-hall',
      startOffsetMinutes: 170, // ~2h50m out -> TIME_INCOMPATIBLE for a near-term request
      durationMinutes: 60,
      capacity: 6,
      participantCount: 1,
      createdOffsetMinutes: -20,
    }),
    buildEvent(now, {
      id: 'evt-expired-1',
      activityId: 'treadmill',
      creatorId: 'staff',
      locationId: 'doherty-hall',
      startOffsetMinutes: -130, // already happened
      durationMinutes: 60,
      capacity: 6,
      participantCount: 2,
      createdOffsetMinutes: -180,
      expiresOffsetMinutes: -10, // expired 10 minutes ago (see file doc comment)
    }),

    // --- OWN_EVENT: one per demo user --------------------------------------
    buildEvent(now, {
      id: 'evt-own-alice',
      activityId: 'treadmill',
      creatorId: 'alice',
      locationId: 'newell-simon',
      startOffsetMinutes: 25,
      durationMinutes: 45,
      capacity: 6,
      participantCount: 1,
      createdOffsetMinutes: -12,
    }),
    buildEvent(now, {
      id: 'evt-own-bob',
      activityId: 'workout',
      creatorId: 'bob',
      locationId: 'hunt-library',
      startOffsetMinutes: 50,
      durationMinutes: 60,
      capacity: 6,
      participantCount: 2,
      createdOffsetMinutes: -18,
    }),
    buildEvent(now, {
      id: 'evt-own-carol',
      activityId: 'running',
      creatorId: 'carol',
      locationId: 'baker-porter-hall',
      startOffsetMinutes: 30,
      durationMinutes: 30,
      capacity: 4,
      participantCount: 1,
      createdOffsetMinutes: -6,
    }),
    buildEvent(now, {
      id: 'evt-own-dan',
      activityId: 'basketball',
      creatorId: 'dan',
      locationId: 'gesling-stadium',
      startOffsetMinutes: 60,
      durationMinutes: 90,
      capacity: 10,
      participantCount: 3,
      createdOffsetMinutes: -22,
    }),

    // --- ALREADY_PARTICIPANT bonus ------------------------------------------
    buildEvent(now, {
      id: 'evt-already-participant-alice',
      activityId: 'treadmill',
      creatorId: 'staff',
      locationId: 'sorrells-library',
      startOffsetMinutes: 30,
      durationMinutes: 45,
      capacity: 6,
      participantCount: 2,
      participantIds: ['staff', 'alice'],
      createdOffsetMinutes: -10,
    }),

    // --- Category spread ----------------------------------------------------
    buildEvent(now, {
      id: 'evt-coding-1',
      activityId: 'coding',
      creatorId: 'staff',
      locationId: 'gates-hillman',
      startOffsetMinutes: 40,
      durationMinutes: 90,
      capacity: 8,
      participantCount: 2,
      createdOffsetMinutes: -15,
    }),
    buildEvent(now, {
      id: 'evt-art-1',
      activityId: 'drawing',
      creatorId: 'staff',
      locationId: 'purnell-center',
      startOffsetMinutes: 45,
      durationMinutes: 60,
      capacity: 5,
      participantCount: 1,
      createdOffsetMinutes: -10,
    }),
    buildEvent(now, {
      id: 'evt-study-1',
      activityId: 'studying',
      creatorId: 'staff',
      locationId: 'hunt-library',
      startOffsetMinutes: 60,
      durationMinutes: 90,
      capacity: 6,
      participantCount: 3,
      createdOffsetMinutes: -20,
    }),
    buildEvent(now, {
      id: 'evt-social-1',
      activityId: 'coffee',
      creatorId: 'staff',
      locationId: 'cohon-university-center',
      startOffsetMinutes: 20,
      durationMinutes: 45,
      capacity: 4,
      participantCount: 2,
      createdOffsetMinutes: -10,
    }),
  ];
}
