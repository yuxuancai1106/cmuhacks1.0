/**
 * §24 — the join-conflict fallback.
 *
 * A retrieved, ranked, above-threshold candidate is never proof that it can be
 * joined: between retrieval and the join another request may have filled,
 * closed or expired it. The engine must treat that as a conflict, walk on to
 * the next qualifying candidate, and only create once every one is exhausted.
 */
import { describe, it, expect } from 'vitest';
import type { MatchableEvent } from '../../src/core/types.js';
import { makeEvent, NOW } from '../support/factories.js';
import {
  MINUTE_MS,
  asMatched,
  asPending,
  createConflictingJoinRepository,
  createHarness,
  treadmillIntent,
} from '../support/harness.js';

/**
 * Two candidates at the same location (stage-1 retrieval filters on location
 * id, so a differently-located event would never be retrieved at all),
 * separated only by start time. `event-close` therefore always outranks
 * `event-later`, and both clear the default 0.70 threshold.
 */
const RANKED_SEED: MatchableEvent[] = [
  makeEvent({ id: 'event-close' }),
  makeEvent({
    id: 'event-later',
    startTime: new Date(NOW.getTime() + 40 * MINUTE_MS),
    endTime: new Date(NOW.getTime() + 100 * MINUTE_MS),
  }),
];

describe('§24 join conflict: rank-1 becomes unjoinable between retrieval and join', () => {
  it('joins the next qualifying candidate and counts the conflict', async () => {
    const h = createHarness({
      seed: RANKED_SEED,
      wrapEvents: (inner) => createConflictingJoinRepository(inner, { failures: 1, reason: 'FULL' }),
    });

    const outcome = asMatched(await h.engine.match('user-joiner', treadmillIntent()));

    expect(outcome.eventId).toBe('event-later');
    expect(h.counter('match.join_conflict')).toBe(1);
    expect(h.counter('match.matched')).toBe(1);
    expect(h.counter('event.created')).toBe(0);

    const stored = h.repo.all();
    expect(stored.find((e) => e.id === 'event-close')?.participantIds).toEqual(['user-creator']);
    expect(stored.find((e) => e.id === 'event-later')?.participantIds).toEqual([
      'user-creator',
      'user-joiner',
    ]);
  });

  it('treats ALREADY_PARTICIPANT as a conflict to skip, never as a match', async () => {
    const h = createHarness({
      seed: RANKED_SEED,
      wrapEvents: (inner) =>
        createConflictingJoinRepository(inner, { failures: 1, reason: 'ALREADY_PARTICIPANT' }),
    });

    const outcome = asMatched(await h.engine.match('user-joiner', treadmillIntent()));

    expect(outcome.eventId).toBe('event-later');
    expect(h.counter('match.join_conflict')).toBe(1);
  });

  it('treats a repository error mid-loop as a conflict and keeps going', async () => {
    const h = createHarness({
      seed: RANKED_SEED,
      wrapEvents: (inner) =>
        createConflictingJoinRepository(inner, { failures: 1, mode: 'throw' }),
    });

    const outcome = asMatched(await h.engine.match('user-joiner', treadmillIntent()));

    expect(outcome.eventId).toBe('event-later');
    expect(h.counter('match.join_conflict')).toBe(1);
  });
});

describe('§24 join conflict: every candidate conflicts', () => {
  it('exhausts the ranked list and falls through to creating a new event', async () => {
    const h = createHarness({
      seed: RANKED_SEED,
      wrapEvents: (inner) =>
        createConflictingJoinRepository(inner, {
          failures: Number.POSITIVE_INFINITY,
          reason: 'FULL',
        }),
    });

    const outcome = asPending(await h.engine.match('user-joiner', treadmillIntent()));

    expect(h.counter('match.join_conflict')).toBe(2);
    expect(h.counter('event.created')).toBe(1);
    expect(h.counter('match.matched')).toBe(0);

    const stored = h.repo.all();
    expect(stored).toHaveLength(3);
    expect(stored.find((e) => e.id === outcome.eventId)?.creatorId).toBe('user-joiner');
    // Neither seeded event was touched.
    expect(stored.find((e) => e.id === 'event-close')?.participantCount).toBe(1);
    expect(stored.find((e) => e.id === 'event-later')?.participantCount).toBe(1);
    // A candidate existed; the fall-through was a conflict, not a bad score.
    expect(outcome.bestRejectedScore).toBeGreaterThanOrEqual(h.engine.config.matchThreshold);
  });
});
