/**
 * §22/§29 regression — the suggestions cache key must cover the *whole*
 * location context, not just its first id.
 *
 * `loadEventCounts` filters the nearby-event sweep on every id in
 * `SuggestionContext.locationIds`, so two contexts that merely share a first
 * id genuinely produce different NEARBY_ACTIVITY scores. Keying on
 * `contextLocationIds[0]` alone made them collide, and the second caller was
 * served the first caller's answer.
 *
 * The proof is a contrast, not an equality: the same second context is asked
 * twice — once behind a warm entry for the *first* context, once on a cold
 * cache — and both must agree. Caching is an optimization layer (§29), so a
 * cache hit may never change the answer.
 */
import { describe, it, expect } from 'vitest';
import { makeEvent, NOW } from '../support/factories.js';
import { createHarness } from '../support/harness.js';

/** Shares `loc-a`; differs only in the second id, where the events actually sit. */
const CONTEXT_A = ['loc-a', 'loc-b'];
const CONTEXT_B = ['loc-a', 'loc-c'];

/** Basketball happens at loc-b, coding at loc-c — so the two contexts must diverge. */
const SEED = [
  makeEvent({ id: 'bb-1', creatorId: 'c1', activityId: 'basketball', categoryId: 'fitness', locationId: 'loc-b' }),
  makeEvent({ id: 'bb-2', creatorId: 'c2', activityId: 'basketball', categoryId: 'fitness', locationId: 'loc-b' }),
  makeEvent({ id: 'cd-1', creatorId: 'c3', activityId: 'coding', categoryId: 'coding', locationId: 'loc-c' }),
  makeEvent({ id: 'cd-2', creatorId: 'c4', activityId: 'coding', categoryId: 'coding', locationId: 'loc-c' }),
];

function reasonsFor(
  suggestions: Array<{ activityId: string; reason: string[] }>,
  activityId: string,
): string[] {
  return suggestions.find((s) => s.activityId === activityId)?.reason ?? [];
}

describe('suggestActivities(): the cache key covers every context location', () => {
  it('does not serve one location context the answer cached for another that shares its first id', async () => {
    const warm = createHarness({ seed: SEED });
    await warm.engine.suggestActivities('user-x', { at: NOW, locationIds: CONTEXT_A });
    const behindWarmEntry = await warm.engine.suggestActivities('user-x', {
      at: NOW,
      locationIds: CONTEXT_B,
    });

    const cold = createHarness({ seed: SEED });
    const onColdCache = await cold.engine.suggestActivities('user-x', {
      at: NOW,
      locationIds: CONTEXT_B,
    });

    expect(behindWarmEntry).toEqual(onColdCache);
    // Both misses: context B must not have hit context A's entry.
    expect(warm.counter('suggestions.cache.miss')).toBe(2);
    expect(warm.counter('suggestions.cache.hit')).toBe(0);
  });

  it('reports NEARBY_ACTIVITY against the context actually asked for', async () => {
    const h = createHarness({ seed: SEED });

    const a = await h.engine.suggestActivities('user-y', { at: NOW, locationIds: CONTEXT_A });
    const b = await h.engine.suggestActivities('user-y', { at: NOW, locationIds: CONTEXT_B });

    // loc-b holds the basketball events, loc-c the coding ones.
    expect(reasonsFor(a, 'basketball')).toContain('NEARBY_ACTIVITY');
    expect(reasonsFor(a, 'coding')).not.toContain('NEARBY_ACTIVITY');
    expect(reasonsFor(b, 'coding')).toContain('NEARBY_ACTIVITY');
    expect(reasonsFor(b, 'basketball')).not.toContain('NEARBY_ACTIVITY');
  });

  it('is order-insensitive: the same location set in either order shares one entry', async () => {
    const h = createHarness({ seed: SEED });

    const forwards = await h.engine.suggestActivities('user-z', { at: NOW, locationIds: ['loc-a', 'loc-b'] });
    const backwards = await h.engine.suggestActivities('user-z', { at: NOW, locationIds: ['loc-b', 'loc-a'] });

    expect(backwards).toEqual(forwards);
    expect(h.counter('suggestions.cache.hit')).toBe(1);
    expect(h.counter('suggestions.cache.miss')).toBe(1);
  });
});
