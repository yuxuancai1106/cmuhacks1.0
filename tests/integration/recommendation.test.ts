/**
 * §20-§21 — the real-time advisory path.
 *
 * Two properties matter here and both are asserted structurally rather than by
 * inspection: `recommend` never writes, and `recommend` never calls the model
 * (the latter lives in `llmBudget.test.ts`). "Never writes" is asserted as
 * "the write methods of the port were never invoked", which is stronger than
 * comparing the store before and after.
 */
import { describe, it, expect } from 'vitest';
import type { MatchableEvent } from '../../src/core/types.js';
import { makeEvent, NOW } from '../support/factories.js';
import {
  MINUTE_MS,
  UNMAPPABLE_TEXT,
  createSpyHarness,
  createThrowingAvailability,
  createThrowingIdempotencyStore,
  treadmillIntent,
} from '../support/harness.js';

describe('recommend(): strictly read-only', () => {
  it('never calls createEvent or joinEventAtomically, and leaves the store byte-for-byte identical', async () => {
    const h = createSpyHarness({ seed: [makeEvent(), makeEvent({ id: 'event-2' })] });
    const before = JSON.stringify(h.repo.all());

    const result = await h.engine.recommend(treadmillIntent(), 'user-b');

    expect(result.advisory).toBe(true);
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(h.spy.calls.createEvent).toBe(0);
    expect(h.spy.calls.joinEventAtomically).toBe(0);
    expect(h.spy.calls.findCandidates).toBe(1);
    expect(JSON.stringify(h.repo.all())).toBe(before);
  });

  it('stays read-only for an anonymous caller too', async () => {
    const h = createSpyHarness({ seed: [makeEvent()] });
    const before = JSON.stringify(h.repo.all());

    await h.engine.recommend(treadmillIntent());

    expect(h.spy.calls.createEvent).toBe(0);
    expect(h.spy.calls.joinEventAtomically).toBe(0);
    expect(JSON.stringify(h.repo.all())).toBe(before);
  });
});

describe('recommend(): nothing resolvable', () => {
  it('returns [] without touching the repository at all', async () => {
    const h = createSpyHarness({ seed: [makeEvent()] });

    const unmappable = await h.engine.recommend({ text: UNMAPPABLE_TEXT }, 'user-b');
    const empty = await h.engine.recommend({}, 'user-b');
    const bogusIds = await h.engine.recommend({ activityIds: ['not-a-real-thing'] }, 'user-b');

    for (const result of [unmappable, empty, bogusIds]) {
      expect(result).toEqual({ recommendations: [], advisory: true, cacheHit: false });
    }
    expect(h.spy.totalCalls).toBe(0);
  });
});

describe('recommend(): caching', () => {
  it('serves an identical repeat call from cache with zero additional repository calls', async () => {
    const h = createSpyHarness({ seed: [makeEvent()] });

    const first = await h.engine.recommend(treadmillIntent(), 'user-b');
    const second = await h.engine.recommend(treadmillIntent(), 'user-b');

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.recommendations).toEqual(first.recommendations);
    expect(h.spy.calls.findCandidates).toBe(1);
    expect(h.counter('recommendation.cache.hit')).toBe(1);
    expect(h.counter('recommendation.cache.miss')).toBe(1);
  });

  it('does not serve one user their own cached results back to another user', async () => {
    const h = createSpyHarness({ seed: [makeEvent()] });

    await h.engine.recommend(treadmillIntent(), 'user-b');
    const other = await h.engine.recommend(treadmillIntent(), 'user-c');

    expect(other.cacheHit).toBe(false);
    expect(h.spy.calls.findCandidates).toBe(2);
  });
});

describe('recommend(): re-queries once the cache entry expires', () => {
  it('is a miss again after config.cache.recommendationMs has elapsed', async () => {
    const h = createSpyHarness({ seed: [makeEvent()] });

    await h.engine.recommend(treadmillIntent(), 'user-b');
    const withinTtl = await h.engine.recommend(treadmillIntent(), 'user-b');
    // The cache shares the engine's injected clock, so advancing it is a
    // deterministic stand-in for time passing — no real timers involved.
    h.clock.advance(h.engine.config.cache.recommendationMs + 1);
    const afterTtl = await h.engine.recommend(treadmillIntent(), 'user-b');

    expect(withinTtl.cacheHit).toBe(true);
    expect(afterTtl.cacheHit).toBe(false);
    expect(h.spy.calls.findCandidates).toBe(2);
  });
});

describe('recommend(): touches neither availability nor idempotency', () => {
  it('works with both of those ports wired to throw on every call', async () => {
    const h = createSpyHarness({
      seed: [makeEvent()],
      availability: createThrowingAvailability(),
      idempotency: createThrowingIdempotencyStore(),
    });

    const result = await h.engine.recommend(
      treadmillIntent({ startTime: undefined, endTime: undefined, idempotencyKey: 'k' }),
      'user-b',
    );

    expect(result.advisory).toBe(true);
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(h.spy.calls.createEvent).toBe(0);
    expect(h.spy.calls.joinEventAtomically).toBe(0);
  });
});

describe('recommend(): ranking and limits', () => {
  /** Twelve otherwise-identical candidates, each starting one minute later than the last. */
  const laddered: MatchableEvent[] = Array.from({ length: 12 }, (_, index) => {
    const offsetMinutes = 6 + index;
    return makeEvent({
      id: `event-${String(index).padStart(2, '0')}`,
      startTime: new Date(NOW.getTime() + (30 + offsetMinutes) * MINUTE_MS),
      endTime: new Date(NOW.getTime() + (90 + offsetMinutes) * MINUTE_MS),
    });
  });

  it('caps results at config.recommendationLimit and orders them by descending score', async () => {
    const h = createSpyHarness({ seed: laddered });

    const result = await h.engine.recommend(treadmillIntent(), 'user-b');
    const limit = h.engine.config.recommendationLimit;

    expect(laddered.length).toBeGreaterThan(limit);
    expect(result.recommendations).toHaveLength(limit);

    const scores = result.recommendations.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    // Closest start time first — the ladder is strictly ordered, so the kept
    // set is exactly the top `limit`, not an arbitrary `limit` of them.
    expect(result.recommendations.map((r) => r.eventId)).toEqual(
      laddered.slice(0, limit).map((e) => e.id),
    );
  });

  it('honours a lowered recommendationLimit', async () => {
    const h = createSpyHarness({ seed: laddered, config: { recommendationLimit: 3 } });

    const result = await h.engine.recommend(treadmillIntent(), 'user-b');

    expect(result.recommendations).toHaveLength(3);
    expect(result.recommendations.map((r) => r.eventId)).toEqual([
      'event-00',
      'event-01',
      'event-02',
    ]);
  });
});

describe('recommend(): unjoinable events never surface', () => {
  it('omits expired, full, cancelled and already-matched events', async () => {
    const h = createSpyHarness({
      seed: [
        makeEvent({ id: 'ok' }),
        makeEvent({ id: 'expired', expiresAt: new Date(NOW.getTime() - MINUTE_MS) }),
        makeEvent({ id: 'full', capacity: 6, participantCount: 6 }),
        makeEvent({ id: 'cancelled', status: 'CANCELLED' }),
        makeEvent({ id: 'closed', status: 'MATCHED' }),
      ],
    });

    const result = await h.engine.recommend(treadmillIntent(), 'user-b');

    expect(result.recommendations.map((r) => r.eventId)).toEqual(['ok']);
  });

  it('omits events the caller created or has already joined', async () => {
    const h = createSpyHarness({
      seed: [
        makeEvent({ id: 'mine', creatorId: 'user-b', participantIds: ['user-b'] }),
        makeEvent({
          id: 'already-joined',
          participantIds: ['user-creator', 'user-b'],
          participantCount: 2,
        }),
        makeEvent({ id: 'open-to-me' }),
      ],
    });

    const result = await h.engine.recommend(treadmillIntent(), 'user-b');

    expect(result.recommendations.map((r) => r.eventId)).toEqual(['open-to-me']);
  });
});
