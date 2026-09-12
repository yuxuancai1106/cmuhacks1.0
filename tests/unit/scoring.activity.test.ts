import { describe, it, expect } from 'vitest';
import { activityScore } from '../../src/scoring/activity.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { makeEvent, makeIntent, makeTaxonomyIndex } from '../../tests/support/factories.js';

const taxonomy = makeTaxonomyIndex();

/**
 * These pin down the spec's own stated intuitions for the controlled
 * vocabulary (treadmill/workout/running/basketball/painting). They run
 * against the real `DEFAULT_TAXONOMY` + `buildTaxonomyIndex`, not a mock,
 * so a regression in either the taxonomy data or the taxonomy index would
 * fail here too.
 */
describe('activityScore — spec intuitions', () => {
  it('scores an exact activity match at 1.0 (treadmill -> treadmill)', () => {
    const intent = makeIntent({ activityIds: ['treadmill'], categoryIds: [] });
    const event = makeEvent({ activityId: 'treadmill' });
    expect(activityScore(intent, event, taxonomy, DEFAULT_CONFIG)).toBe(1.0);
  });

  it('scores treadmill -> workout at ~0.8 (direct child to parent)', () => {
    const intent = makeIntent({ activityIds: ['treadmill'], categoryIds: [] });
    const event = makeEvent({ activityId: 'workout', categoryId: 'fitness' });
    expect(activityScore(intent, event, taxonomy, DEFAULT_CONFIG)).toBeCloseTo(0.8, 5);
  });

  it('scores running -> treadmill at ~0.7 (explicit relatedIds cross-link)', () => {
    const intent = makeIntent({ activityIds: ['running'], categoryIds: [] });
    const event = makeEvent({ activityId: 'treadmill' });
    expect(activityScore(intent, event, taxonomy, DEFAULT_CONFIG)).toBeCloseTo(0.7, 5);
  });

  it('scores basketball -> workout strictly lower than treadmill -> workout', () => {
    const event = makeEvent({ activityId: 'workout', categoryId: 'fitness' });
    const basketballIntent = makeIntent({ activityIds: ['basketball'], categoryIds: [] });
    const treadmillIntent = makeIntent({ activityIds: ['treadmill'], categoryIds: [] });

    const basketballScore = activityScore(basketballIntent, event, taxonomy, DEFAULT_CONFIG);
    const treadmillScore = activityScore(treadmillIntent, event, taxonomy, DEFAULT_CONFIG);

    expect(basketballScore).toBeLessThan(treadmillScore);
  });

  it('scores painting -> treadmill at 0.0 (unrelated categories)', () => {
    const intent = makeIntent({ activityIds: ['painting'], categoryIds: [] });
    const event = makeEvent({ activityId: 'treadmill' });
    expect(activityScore(intent, event, taxonomy, DEFAULT_CONFIG)).toBe(0.0);
  });
});

describe('activityScore — combining multiple intent activities', () => {
  it('takes the best (max) similarity across all intent activities', () => {
    const intent = makeIntent({ activityIds: ['painting', 'treadmill'], categoryIds: [] });
    const event = makeEvent({ activityId: 'workout', categoryId: 'fitness' });
    // painting->workout is unrelated (0); treadmill->workout is 0.8 — the
    // best of the two must win, not e.g. an average.
    expect(activityScore(intent, event, taxonomy, DEFAULT_CONFIG)).toBeCloseTo(0.8, 5);
  });
});

describe('activityScore — category-only fallback', () => {
  it('scores a category match at the configured sameCategory value when the intent has no activities', () => {
    const intent = makeIntent({ activityIds: [], categoryIds: ['fitness'] });
    const event = makeEvent({ activityId: 'workout', categoryId: 'fitness' });
    expect(activityScore(intent, event, taxonomy, DEFAULT_CONFIG)).toBe(
      DEFAULT_CONFIG.activitySimilarity.sameCategory,
    );
  });

  it('scores 0 when the event category is not among the intent categories', () => {
    const intent = makeIntent({ activityIds: [], categoryIds: ['fitness'] });
    const event = makeEvent({ activityId: 'painting', categoryId: 'art' });
    expect(activityScore(intent, event, taxonomy, DEFAULT_CONFIG)).toBe(0);
  });
});

describe('activityScore — nothing to compare against', () => {
  it('scores 0 when the intent has neither activities nor categories', () => {
    const intent = makeIntent({ activityIds: [], categoryIds: [] });
    const event = makeEvent();
    expect(activityScore(intent, event, taxonomy, DEFAULT_CONFIG)).toBe(0);
  });
});
