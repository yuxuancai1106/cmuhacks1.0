/**
 * §30 — graceful degradation.
 *
 * Every optional port is knocked over one at a time. The bar is not "does not
 * crash": it is that a **usable** outcome still comes back, built from the
 * structured information the engine still has.
 */
import { describe, it, expect } from 'vitest';
import { UNSPECIFIED_LOCATION_ID, createNullLlmClient } from '../../src/index.js';
import { makeEvent, NOW } from '../support/factories.js';
import {
  MINUTE_MS,
  NOVEL_TEXT_A,
  asMatched,
  asPending,
  asRejected,
  createFixedAvailability,
  createHarness,
  createProfileService,
  createThrowingAvailability,
  createThrowingCache,
  createThrowingProfileService,
  treadmillIntent,
} from '../support/harness.js';

describe('§30 the LLM is down', () => {
  it('still matches on the structured selections and reports the fallback source', async () => {
    const h = createHarness({ seed: [makeEvent()], llmClient: createNullLlmClient() });

    const outcome = asMatched(
      await h.engine.match('user-joiner', treadmillIntent({ text: NOVEL_TEXT_A })),
    );

    expect(outcome.eventId).toBe('event-1');
    expect(outcome.semanticSource).toBe('FALLBACK');
    expect(h.counter('llm.calls')).toBe(1);
    expect(h.counter('llm.errors')).toBe(1);
  });

  it('produces no unhandled rejection when the client rejects', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
    try {
      const h = createHarness({ seed: [makeEvent()], llmClient: createNullLlmClient() });
      await h.engine.match('user-joiner', treadmillIntent({ text: NOVEL_TEXT_A }));
      // Unhandled rejections are reported on the next macrotask turn.
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', listener);
    }

    expect(unhandled).toEqual([]);
  });
});

describe('§30 the LLM answers, but with junk', () => {
  it('does not trust an activity outside the controlled vocabulary', async () => {
    const h = createHarness({
      seed: [makeEvent()],
      llmResponse: () => ({
        canonicalActivity: 'underwater basket weaving',
        category: 'aquatics',
        tags: ['glorp'],
        confidence: 0.99,
      }),
    });

    const outcome = asMatched(
      await h.engine.match('user-joiner', treadmillIntent({ text: NOVEL_TEXT_A })),
    );

    expect(outcome.semanticSource).toBe('FALLBACK');
    expect(outcome.event.activityId).toBe('treadmill');
    expect(h.counter('llm.errors')).toBe(1);
  });

  it('does not trust a response that is not even an object', async () => {
    const h = createHarness({ seed: [makeEvent()], llmResponse: () => 'treadmill' });

    const outcome = asMatched(
      await h.engine.match('user-joiner', treadmillIntent({ text: NOVEL_TEXT_A })),
    );

    expect(outcome.semanticSource).toBe('FALLBACK');
    expect(h.counter('llm.errors')).toBe(1);
  });

  it('does not trust — or cache — an interpretation below minSemanticConfidence', async () => {
    const h = createHarness({
      llmResponse: () => ({
        canonicalActivity: 'workout',
        category: 'fitness',
        tags: ['maybe'],
        confidence: 0.1,
      }),
    });

    const first = asRejected(await h.engine.match('user-a', { text: NOVEL_TEXT_A }));
    const second = asRejected(await h.engine.match('user-b', { text: NOVEL_TEXT_A }));

    expect(first.semanticSource).toBe('FALLBACK');
    expect(second.semanticSource).toBe('FALLBACK');
    expect(h.repo.all()).toEqual([]);
    // An untrusted interpretation must not be cached as if it were good.
    expect(h.llm.callCount).toBe(2);
    expect(h.counter('llm.errors')).toBe(2);
  });
});

describe('§30 the availability service is down', () => {
  it('falls back to now + fallbackStartOffsetMinutes for the activity duration', async () => {
    const h = createHarness({ availability: createThrowingAvailability() });

    const outcome = asPending(await h.engine.match('user-a', { activityIds: ['treadmill'] }));

    const offset = h.engine.config.fallbackStartOffsetMinutes;
    const duration = h.engine.config.activityDurationsMinutes['treadmill'];
    expect(duration).toBeDefined();
    expect(outcome.event.startTime.getTime()).toBe(NOW.getTime() + offset * MINUTE_MS);
    expect(outcome.event.endTime.getTime()).toBe(
      NOW.getTime() + (offset + (duration ?? 0)) * MINUTE_MS,
    );
  });

  it('uses a healthy availability slot, proving the fallback above is the degraded path', async () => {
    const slot = {
      startTime: new Date(NOW.getTime() + 180 * MINUTE_MS),
      endTime: new Date(NOW.getTime() + 240 * MINUTE_MS),
    };
    const h = createHarness({ availability: createFixedAvailability(slot) });

    const outcome = asPending(await h.engine.match('user-a', { activityIds: ['treadmill'] }));

    expect(outcome.event.startTime.getTime()).toBe(slot.startTime.getTime());
    expect(outcome.event.endTime.getTime()).toBe(slot.endTime.getTime());
  });
});

describe('§30 the cache is down', () => {
  it('serves match, recommend and suggestActivities with a cache that throws on get and set', async () => {
    const h = createHarness({ seed: [makeEvent()], cache: createThrowingCache() });

    const matched = asMatched(await h.engine.match('user-joiner', treadmillIntent()));
    const first = await h.engine.recommend(treadmillIntent(), 'user-c');
    const second = await h.engine.recommend(treadmillIntent(), 'user-c');
    const suggestions = await h.engine.suggestActivities('user-c');

    expect(matched.eventId).toBe('event-1');
    expect(first.recommendations.length).toBeGreaterThan(0);
    // No cache means every read is a miss — degraded, but correct.
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(false);
    expect(suggestions.length).toBeGreaterThan(0);
  });

  it('still resolves novel text through the LLM when the semantic cache is unavailable', async () => {
    const h = createHarness({ cache: createThrowingCache() });

    const first = asPending(await h.engine.match('user-a', { text: NOVEL_TEXT_A }));
    await h.engine.match('user-b', { text: NOVEL_TEXT_A });

    expect(first.semanticSource).toBe('LLM');
    // The budget degrades (no cache to hit) but the request still succeeds.
    expect(h.llm.callCount).toBe(2);
  });
});

describe('§30 the profile service is down', () => {
  it('matches when getProfile throws', async () => {
    const h = createHarness({ seed: [makeEvent()], profiles: createThrowingProfileService() });

    const outcome = asMatched(await h.engine.match('user-joiner', treadmillIntent()));

    expect(outcome.eventId).toBe('event-1');
  });

  it('matches when getProfile returns null', async () => {
    const h = createHarness({ seed: [makeEvent()], profiles: createProfileService(null) });

    const outcome = asMatched(await h.engine.match('user-joiner', treadmillIntent()));

    expect(outcome.eventId).toBe('event-1');
  });

  it('still returns suggestions with no profile at all', async () => {
    const h = createHarness({ profiles: createThrowingProfileService() });

    const suggestions = await h.engine.suggestActivities('user-a');

    expect(suggestions.length).toBeGreaterThan(0);
  });
});

describe('§30 no usable location', () => {
  it('drops unknown location ids and matches without a location constraint', async () => {
    const h = createHarness({ seed: [makeEvent()] });

    const outcome = asMatched(
      await h.engine.match('user-joiner', treadmillIntent({ locationIds: ['nowhere-at-all'] })),
    );

    expect(outcome.eventId).toBe('event-1');
    expect(outcome.breakdown.location).toBe(1);
  });

  it('ignores coordinates that resolve to no canonical location', async () => {
    const h = createHarness({ seed: [makeEvent()] });

    const farAway = asMatched(
      await h.engine.match(
        'user-joiner',
        treadmillIntent({ locationIds: [], coordinates: { latitude: 0, longitude: 0 } }),
      ),
    );
    const nonsense = asMatched(
      await h.engine.match(
        'user-other',
        treadmillIntent({ locationIds: [], coordinates: { latitude: 91, longitude: 999 } }),
      ),
    );

    expect(farAway.eventId).toBe('event-1');
    expect(nonsense.eventId).toBe('event-1');
  });

  it('creates an event at the unspecified sentinel and still lets the next user join it', async () => {
    const h = createHarness();

    const created = asPending(await h.engine.match('user-a', { activityIds: ['treadmill'] }));
    expect(created.event.locationId).toBe(UNSPECIFIED_LOCATION_ID);

    const joined = asMatched(await h.engine.match('user-b', { activityIds: ['treadmill'] }));
    expect(joined.eventId).toBe(created.eventId);
    expect(h.repo.all()).toHaveLength(1);
  });

  it('returns suggestions for an unknown context location', async () => {
    const h = createHarness({ seed: [makeEvent()] });

    const suggestions = await h.engine.suggestActivities('user-a', {
      locationIds: ['nowhere-at-all'],
    });

    expect(suggestions.length).toBeGreaterThan(0);
  });
});
