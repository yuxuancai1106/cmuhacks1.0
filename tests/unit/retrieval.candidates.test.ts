import { describe, it, expect } from 'vitest';
import { buildCandidateQuery } from '../../src/retrieval/candidates.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { makeIntent, makeTaxonomyIndex, NOW } from '../../tests/support/factories.js';

const taxonomy = makeTaxonomyIndex();
const padMs = DEFAULT_CONFIG.retrievalWindowMinutes * 60_000;

describe('buildCandidateQuery — activity/category widening', () => {
  it('widens intent activities via the taxonomy and includes their categories', () => {
    const intent = makeIntent({ activityIds: ['treadmill'], categoryIds: [] });
    const query = buildCandidateQuery({ intent, taxonomy, config: DEFAULT_CONFIG, now: NOW });

    const expected = taxonomy.expand(['treadmill']);
    expect(query.activityIds).toEqual(expected.activityIds);
    expect(query.categoryIds).toEqual(expected.categoryIds);
  });

  it('unions expanded categories with any explicit intent categories, de-duplicated', () => {
    const intent = makeIntent({ activityIds: ['treadmill'], categoryIds: ['fitness', 'art'] });
    const query = buildCandidateQuery({ intent, taxonomy, config: DEFAULT_CONFIG, now: NOW });

    expect(query.categoryIds).toEqual(['fitness', 'art']);
    expect(new Set(query.categoryIds).size).toBe(query.categoryIds.length);
  });

  it('never throws for an intent with no recognizable activities', () => {
    const intent = makeIntent({ activityIds: [], categoryIds: ['fitness'] });
    expect(() => buildCandidateQuery({ intent, taxonomy, config: DEFAULT_CONFIG, now: NOW })).not.toThrow();
  });
});

describe('buildCandidateQuery — retrieval window', () => {
  it('centers the window on the intent start time, padded by retrievalWindowMinutes', () => {
    const intent = makeIntent({ startTime: NOW, endTime: undefined });
    const query = buildCandidateQuery({ intent, taxonomy, config: DEFAULT_CONFIG, now: NOW });

    expect(query.windowStart.getTime()).toBe(NOW.getTime() - padMs);
    expect(query.windowEnd.getTime()).toBe(NOW.getTime() + padMs);
  });

  it('falls back to [now, now + pad] when the intent has no start time', () => {
    const intent = makeIntent({ startTime: undefined, endTime: undefined });
    const query = buildCandidateQuery({ intent, taxonomy, config: DEFAULT_CONFIG, now: NOW });

    expect(query.windowStart.getTime()).toBe(NOW.getTime());
    expect(query.windowEnd.getTime()).toBe(NOW.getTime() + padMs);
  });
});

describe('buildCandidateQuery — pass-through fields', () => {
  it('copies the intent location ids', () => {
    const intent = makeIntent({ locationIds: ['loc-a', 'loc-b'] });
    const query = buildCandidateQuery({ intent, taxonomy, config: DEFAULT_CONFIG, now: NOW });
    expect(query.locationIds).toEqual(['loc-a', 'loc-b']);
  });

  it('uses the configured candidate limit', () => {
    const intent = makeIntent();
    const query = buildCandidateQuery({ intent, taxonomy, config: DEFAULT_CONFIG, now: NOW });
    expect(query.limit).toBe(DEFAULT_CONFIG.candidateLimit);
  });

  it('passes through `now` and an optional excludeUserId', () => {
    const intent = makeIntent();
    const withExclude = buildCandidateQuery({
      intent,
      taxonomy,
      config: DEFAULT_CONFIG,
      now: NOW,
      excludeUserId: 'user-1',
    });
    expect(withExclude.now).toEqual(NOW);
    expect(withExclude.excludeUserId).toBe('user-1');

    const withoutExclude = buildCandidateQuery({ intent, taxonomy, config: DEFAULT_CONFIG, now: NOW });
    expect(withoutExclude.excludeUserId).toBeUndefined();
  });
});
