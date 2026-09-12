import { describe, it, expect } from 'vitest';
import { qualityScore } from '../../src/scoring/quality.js';
import { makeEvent, NOW } from '../../tests/support/factories.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Freshest-possible event: created right now, with a full day of runway left. */
function freshEvent(overrides: Parameters<typeof makeEvent>[0] = {}) {
  return makeEvent({
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + DAY_MS),
    ...overrides,
  });
}

describe('qualityScore — fill ratio (peaks at 50% capacity)', () => {
  it('scores a half-full event higher than an empty one, at equal freshness', () => {
    const half = freshEvent({ capacity: 10, participantCount: 5 });
    const empty = freshEvent({ capacity: 10, participantCount: 0 });
    expect(qualityScore(half, NOW)).toBeGreaterThan(qualityScore(empty, NOW));
  });

  it('scores a half-full event higher than a nearly-full one, at equal freshness', () => {
    const half = freshEvent({ capacity: 10, participantCount: 5 });
    const nearlyFull = freshEvent({ capacity: 10, participantCount: 9 });
    expect(qualityScore(half, NOW)).toBeGreaterThan(qualityScore(nearlyFull, NOW));
  });

  it('treats capacity <= 0 as unusable (0 fill contribution) rather than throwing or dividing by zero', () => {
    const event = freshEvent({ capacity: 0, participantCount: 0 });
    expect(() => qualityScore(event, NOW)).not.toThrow();
    // Fill contributes 0; freshness is maximal (1) -> blended result is 0.5.
    expect(qualityScore(event, NOW)).toBeCloseTo(0.5, 10);
  });
});

describe('qualityScore — freshness', () => {
  it('scores a newly-created event with lots of runway higher than an old one, at equal fill', () => {
    const fresh = makeEvent({
      capacity: 10,
      participantCount: 5,
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + DAY_MS),
    });
    const old = makeEvent({
      capacity: 10,
      participantCount: 5,
      createdAt: new Date(NOW.getTime() - DAY_MS),
      expiresAt: new Date(NOW.getTime() + DAY_MS),
    });
    expect(qualityScore(fresh, NOW)).toBeGreaterThan(qualityScore(old, NOW));
  });

  it('scores an event about to expire lower than one with a full day of runway, at equal fill', () => {
    const aboutToExpire = makeEvent({
      capacity: 10,
      participantCount: 5,
      createdAt: NOW,
      expiresAt: NOW,
    });
    const longRunway = freshEvent({ capacity: 10, participantCount: 5 });
    expect(qualityScore(aboutToExpire, NOW)).toBeLessThan(qualityScore(longRunway, NOW));
  });
});

describe('qualityScore — result bounds', () => {
  it('always returns a value within [0, 1]', () => {
    const event = freshEvent({ capacity: 4, participantCount: 4 });
    const score = qualityScore(event, NOW);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});
