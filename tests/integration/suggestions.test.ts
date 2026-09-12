/**
 * §22 — personalized activity suggestions.
 *
 * Two claims: the path is deterministic and LLM-free, and the diversity
 * constraint genuinely bites. The second is proved by contrast — the same
 * profile under a wider `maxSuggestionsPerCategory` returns more same-category
 * entries, so the cap is what limits the list, not an accident of scoring.
 */
import { describe, it, expect } from 'vitest';
import { createNullCache } from '../../src/index.js';
import type { ActivitySuggestion, UserProfile } from '../../src/index.js';
import { makeEvent, NOW } from '../support/factories.js';
import { createHarness, createProfileService } from '../support/harness.js';

/** Every top signal points at one category: interests, and what they did lately. */
const FITNESS_PROFILE: UserProfile = {
  userId: 'user-fit',
  interestActivityIds: ['workout', 'running', 'treadmill', 'basketball'],
  interestCategoryIds: ['fitness'],
  recentActivityIds: ['treadmill', 'running', 'workout'],
};

function countByCategory(suggestions: ActivitySuggestion[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const suggestion of suggestions) {
    counts.set(suggestion.categoryId, (counts.get(suggestion.categoryId) ?? 0) + 1);
  }
  return counts;
}

describe('suggestActivities(): deterministic and LLM-free', () => {
  it('returns the identical list on repeated calls, with the cache disabled', async () => {
    const h = createHarness({
      seed: [makeEvent()],
      cache: createNullCache(),
      profiles: createProfileService(FITNESS_PROFILE),
    });

    const runs = [
      await h.engine.suggestActivities('user-fit', { at: NOW }),
      await h.engine.suggestActivities('user-fit', { at: NOW }),
      await h.engine.suggestActivities('user-fit', { at: NOW }),
    ];

    expect(runs[0]?.length).toBeGreaterThan(0);
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
    expect(h.llm.callCount).toBe(0);
    expect(h.counter('llm.calls')).toBe(0);
  });

  it('returns the identical list from a freshly constructed engine — no hidden state', async () => {
    const options = {
      seed: [makeEvent()],
      cache: createNullCache(),
      profiles: createProfileService(FITNESS_PROFILE),
    };

    const a = await createHarness(options).engine.suggestActivities('user-fit', { at: NOW });
    const b = await createHarness(options).engine.suggestActivities('user-fit', { at: NOW });

    expect(b).toEqual(a);
  });

  it('serves a repeat call from the short-lived cache without calling the model', async () => {
    const h = createHarness({ profiles: createProfileService(FITNESS_PROFILE) });

    const first = await h.engine.suggestActivities('user-fit');
    const second = await h.engine.suggestActivities('user-fit');

    expect(second).toEqual(first);
    expect(h.counter('suggestions.cache.hit')).toBe(1);
    expect(h.counter('suggestions.cache.miss')).toBe(1);
    expect(h.llm.callCount).toBe(0);
  });
});

describe('suggestActivities(): the diversity constraint bites', () => {
  it('never exceeds maxSuggestionsPerCategory, even for a single-interest profile', async () => {
    const h = createHarness({
      cache: createNullCache(),
      profiles: createProfileService(FITNESS_PROFILE),
    });

    const suggestions = await h.engine.suggestActivities('user-fit', { at: NOW });
    const perCategory = countByCategory(suggestions);

    expect(suggestions.length).toBeLessThanOrEqual(h.engine.config.suggestionLimit);
    for (const [, count] of perCategory) {
      expect(count).toBeLessThanOrEqual(h.engine.config.maxSuggestionsPerCategory);
    }
    // Not five near-synonyms: the screen spans several categories.
    expect(perCategory.size).toBeGreaterThan(1);
    expect(perCategory.get('fitness')).toBe(2);
  });

  it('would otherwise be all fitness — widening the cap proves the cap is what limits it', async () => {
    const narrow = createHarness({
      cache: createNullCache(),
      profiles: createProfileService(FITNESS_PROFILE),
    });
    const wide = createHarness({
      cache: createNullCache(),
      profiles: createProfileService(FITNESS_PROFILE),
      config: { maxSuggestionsPerCategory: 5 },
    });

    const narrowCounts = countByCategory(await narrow.engine.suggestActivities('user-fit', { at: NOW }));
    const wideCounts = countByCategory(await wide.engine.suggestActivities('user-fit', { at: NOW }));

    expect(narrowCounts.get('fitness')).toBe(2);
    // All four fitness activities outrank every other activity for this
    // profile, so without the cap they take the whole head of the list.
    expect(wideCounts.get('fitness')).toBe(4);
  });

  it('caps the whole list at config.suggestionLimit', async () => {
    const h = createHarness({
      cache: createNullCache(),
      profiles: createProfileService(FITNESS_PROFILE),
      config: { suggestionLimit: 3 },
    });

    const suggestions = await h.engine.suggestActivities('user-fit', { at: NOW });

    expect(suggestions).toHaveLength(3);
  });

  it('explains itself: a profile interest surfaces as PROFILE_INTEREST', async () => {
    const h = createHarness({
      cache: createNullCache(),
      profiles: createProfileService(FITNESS_PROFILE),
    });

    const suggestions = await h.engine.suggestActivities('user-fit', { at: NOW });
    const fitness = suggestions.filter((s) => s.categoryId === 'fitness');

    expect(fitness.length).toBeGreaterThan(0);
    for (const suggestion of fitness) {
      expect(suggestion.reason).toContain('PROFILE_INTEREST');
      expect(suggestion.score).toBeGreaterThan(0);
      expect(suggestion.score).toBeLessThanOrEqual(1);
    }
  });
});
