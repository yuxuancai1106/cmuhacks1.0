import { describe, it, expect } from 'vitest';
import { assertWeightsSumToOne, rankCandidates, scoreEvent, type RankerDeps } from '../../src/scoring/score.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { AlgorithmConfig } from '../../src/config/types.js';
import { makeEvent, makeIntent, makeLocationService, makeTaxonomyIndex, NOW } from '../../tests/support/factories.js';

const deps: RankerDeps = {
  taxonomy: makeTaxonomyIndex(),
  locations: makeLocationService(),
  config: DEFAULT_CONFIG,
};

describe('assertWeightsSumToOne', () => {
  it('does not throw for weights that sum to 1', () => {
    expect(() => assertWeightsSumToOne(DEFAULT_CONFIG.weights)).not.toThrow();
  });

  it('throws when weights do not sum to 1', () => {
    expect(() =>
      assertWeightsSumToOne({ activity: 0.5, time: 0.5, location: 0.5, tag: 0, quality: 0 }),
    ).toThrow();
  });
});

describe('scoreEvent', () => {
  it('combines the five sub-scores via the configured weights, clamped to [0, 1]', () => {
    const intent = makeIntent();
    const event = makeEvent();
    const result = scoreEvent(intent, event, deps, NOW);

    const { weights } = DEFAULT_CONFIG;
    const expected =
      weights.activity * result.breakdown.activity +
      weights.time * result.breakdown.time +
      weights.location * result.breakdown.location +
      weights.tag * result.breakdown.tag +
      weights.quality * result.breakdown.quality;

    expect(result.score).toBeCloseTo(Math.min(1, Math.max(0, expected)), 10);
    expect(result.event).toBe(event);
  });
});

describe('rankCandidates — determinism', () => {
  it('produces the identical order across repeated runs over the same input', () => {
    const intent = makeIntent();
    const events = [
      makeEvent({ id: 'event-1', activityId: 'treadmill' }),
      makeEvent({ id: 'event-2', activityId: 'workout' }),
      makeEvent({ id: 'event-3', activityId: 'basketball' }),
      makeEvent({ id: 'event-4', activityId: 'painting', categoryId: 'art' }),
    ];

    const firstRun = rankCandidates(intent, events, deps, NOW).map((s) => s.event.id);
    const secondRun = rankCandidates(intent, events, deps, NOW).map((s) => s.event.id);
    const thirdRun = rankCandidates(intent, [...events].reverse(), deps, NOW).map((s) => s.event.id);

    expect(secondRun).toEqual(firstRun);
    expect(thirdRun).toEqual(firstRun);
  });

  it('does not mutate the input events array', () => {
    const intent = makeIntent();
    const events = [
      makeEvent({ id: 'event-2', activityId: 'workout' }),
      makeEvent({ id: 'event-1', activityId: 'treadmill' }),
    ];
    const idsBefore = events.map((e) => e.id);

    rankCandidates(intent, events, deps, NOW);

    expect(events.map((e) => e.id)).toEqual(idsBefore);
  });
});

describe('rankCandidates — documented tie-break', () => {
  it('breaks an exact score tie by earlier createdAt', () => {
    // Zeroing the quality weight isolates the tie-break from freshness,
    // which would otherwise differ between the two createdAt values.
    const config: AlgorithmConfig = {
      ...DEFAULT_CONFIG,
      weights: { activity: 0.4, time: 0.25, location: 0.2, tag: 0.15, quality: 0 },
    };
    const noQualityDeps: RankerDeps = { ...deps, config };
    const intent = makeIntent();

    const later = makeEvent({ id: 'event-a', createdAt: new Date(NOW.getTime() - 5 * 60_000) });
    const earlier = makeEvent({ id: 'event-z', createdAt: new Date(NOW.getTime() - 20 * 60_000) });

    const ranked = rankCandidates(intent, [later, earlier], noQualityDeps, NOW);

    // 'event-z' would lose an id-only tie-break, but its earlier createdAt
    // must win first.
    expect(ranked.map((s) => s.event.id)).toEqual(['event-z', 'event-a']);
  });

  it('breaks a tie on equal score AND equal createdAt by the lexicographically smaller id', () => {
    const createdAt = new Date(NOW.getTime() - 5 * 60_000);
    const intent = makeIntent();

    const eventB = makeEvent({ id: 'b-event', createdAt });
    const eventA = makeEvent({ id: 'a-event', createdAt });

    const ranked = rankCandidates(intent, [eventB, eventA], deps, NOW);

    expect(ranked.map((s) => s.event.id)).toEqual(['a-event', 'b-event']);
  });
});
