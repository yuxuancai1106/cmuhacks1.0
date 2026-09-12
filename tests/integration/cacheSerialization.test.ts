import { describe, it, expect } from 'vitest';
import { createHarness, treadmillIntent } from '../support/harness.js';
import { makeEvent } from '../support/factories.js';
import type { CacheService, MatchableEvent } from '../../src/index.js';

/**
 * `CacheService` exists so the in-memory default can be swapped for Redis. An
 * in-process Map hands back the very objects that were stored, which hides a
 * whole class of bug: any backend that serializes returns ISO strings where
 * the types promise `Date`. These tests run the real-time path against a cache
 * that JSON round-trips everything, which is what a shared backend actually does.
 */
/** Two open treadmill events at the intent's location, so a hit has content to revive. */
function seedEvents(): MatchableEvent[] {
  return [
    makeEvent({ id: 'evt-1', creatorId: 'host-1', activityId: 'treadmill', locationId: 'loc-a' }),
    makeEvent({ id: 'evt-2', creatorId: 'host-2', activityId: 'treadmill', locationId: 'loc-a' }),
  ];
}

function createSerializingCache(): CacheService {
  const store = new Map<string, { json: string; expiresAt: number }>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const entry = store.get(key);
      if (entry === undefined) return undefined;
      if (Date.now() >= entry.expiresAt) {
        store.delete(key);
        return undefined;
      }
      return JSON.parse(entry.json) as T;
    },
    async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
      store.set(key, { json: JSON.stringify(value), expiresAt: Date.now() + ttlMs });
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
  };
}

describe('recommendation cache against a serializing backend', () => {
  it('returns real Date objects on a cache hit, not ISO strings', async () => {
    const harness = createHarness({ cache: createSerializingCache(), seed: seedEvents() });
    const intent = treadmillIntent();

    const miss = await harness.engine.recommend(intent, 'user-reader');
    expect(miss.cacheHit).toBe(false);
    expect(miss.recommendations.length).toBeGreaterThan(0);

    const hit = await harness.engine.recommend(intent, 'user-reader');
    expect(hit.cacheHit).toBe(true);
    expect(hit.recommendations.length).toBe(miss.recommendations.length);

    for (const rec of hit.recommendations) {
      expect(rec.event.startTime).toBeInstanceOf(Date);
      expect(rec.event.endTime).toBeInstanceOf(Date);
      expect(rec.event.createdAt).toBeInstanceOf(Date);
      expect(rec.event.expiresAt).toBeInstanceOf(Date);
      // The failure this guards against is a caller doing exactly this.
      expect(() => rec.event.startTime.getTime()).not.toThrow();
      expect(Number.isNaN(rec.event.startTime.getTime())).toBe(false);
    }
  });

  it('preserves the actual instants through the round trip', async () => {
    const harness = createHarness({ cache: createSerializingCache(), seed: seedEvents() });
    const intent = treadmillIntent();

    const miss = await harness.engine.recommend(intent, 'user-reader');
    const hit = await harness.engine.recommend(intent, 'user-reader');

    const before = miss.recommendations.map((r) => r.event.startTime.getTime());
    const after = hit.recommendations.map((r) => r.event.startTime.getTime());
    expect(after).toEqual(before);
  });

  it('gives each caller an independent object graph on a cache hit', async () => {
    const harness = createHarness({ cache: createSerializingCache(), seed: seedEvents() });
    const intent = treadmillIntent();

    await harness.engine.recommend(intent, 'user-reader');
    const first = await harness.engine.recommend(intent, 'user-reader');
    const second = await harness.engine.recommend(intent, 'user-reader');

    expect(first.recommendations).not.toBe(second.recommendations);
    expect(first.recommendations[0]?.event).not.toBe(second.recommendations[0]?.event);
  });

  it('never hands two callers the same empty-result object', async () => {
    const harness = createHarness({ seed: seedEvents() });
    const a = await harness.engine.recommend({ activityIds: [] }, 'user-a');
    const b = await harness.engine.recommend({ activityIds: [] }, 'user-b');

    expect(a.recommendations).toEqual([]);
    expect(a).not.toBe(b);
    expect(a.recommendations).not.toBe(b.recommendations);
  });
});
