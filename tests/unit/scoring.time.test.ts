import { describe, it, expect } from 'vitest';
import { timeScore, timeOverlapMinutes } from '../../src/scoring/time.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { makeEvent, makeIntent, NOW } from '../../tests/support/factories.js';

const MIN = 60_000;

describe('timeOverlapMinutes — real interval overlap', () => {
  const base = new Date('2026-01-01T00:00:00.000Z');
  const at = (minutes: number) => new Date(base.getTime() + minutes * MIN);

  it('computes overlap for a fully-contained interval', () => {
    expect(timeOverlapMinutes(at(0), at(100), at(20), at(40))).toBe(20);
  });

  it('computes overlap for a partially-overlapping interval', () => {
    expect(timeOverlapMinutes(at(0), at(50), at(30), at(80))).toBe(20);
  });

  it('returns 0 for disjoint intervals', () => {
    expect(timeOverlapMinutes(at(0), at(10), at(20), at(30))).toBe(0);
  });

  it('returns 0 for intervals that only touch at an endpoint', () => {
    expect(timeOverlapMinutes(at(0), at(10), at(10), at(20))).toBe(0);
  });
});

describe('timeScore — spec intuitions', () => {
  it('scores 1.0 when the intent start exactly matches the event start', () => {
    const event = makeEvent({ startTime: NOW, endTime: new Date(NOW.getTime() + 60 * MIN) });
    const intent = makeIntent({ startTime: NOW, endTime: undefined });
    expect(timeScore(intent, event, DEFAULT_CONFIG, NOW)).toBe(1.0);
  });

  it('scores high (but below 1.0) for a 15-minute offset', () => {
    const event = makeEvent({ startTime: NOW, endTime: new Date(NOW.getTime() + 60 * MIN) });
    const intent = makeIntent({ startTime: new Date(NOW.getTime() + 15 * MIN), endTime: undefined });
    const score = timeScore(intent, event, DEFAULT_CONFIG, NOW);
    expect(score).toBeGreaterThan(0.75);
    expect(score).toBeLessThan(1.0);
  });

  it('scores low/zero for a 3-hour offset', () => {
    const event = makeEvent({ startTime: NOW, endTime: new Date(NOW.getTime() + 60 * MIN) });
    const intent = makeIntent({ startTime: new Date(NOW.getTime() + 180 * MIN), endTime: undefined });
    expect(timeScore(intent, event, DEFAULT_CONFIG, NOW)).toBe(0);
  });

  it('scores 0 for an event that has already ended, regardless of how well times align', () => {
    const event = makeEvent({
      startTime: new Date(NOW.getTime() - 120 * MIN),
      endTime: new Date(NOW.getTime() - 10 * MIN),
    });
    // Same start as the (already-ended) event -- would otherwise be a perfect match.
    const intent = makeIntent({ startTime: event.startTime, endTime: undefined });
    expect(timeScore(intent, event, DEFAULT_CONFIG, NOW)).toBe(0);
  });

  it('scores a neutral 0.5 when the intent carries no start time at all', () => {
    const event = makeEvent();
    const intent = makeIntent({ startTime: undefined, endTime: undefined });
    expect(timeScore(intent, event, DEFAULT_CONFIG, NOW)).toBe(0.5);
  });
});

describe('timeScore — uses real interval overlap, not just start-time proximity', () => {
  it('scores two intents with the identical start delta differently based on actual overlap', () => {
    const event = makeEvent({ startTime: NOW, endTime: new Date(NOW.getTime() + 60 * MIN) });

    // Both start 50 minutes after the event -- same proximity component --
    // but one is a short window fully contained in the remaining event time,
    // the other stretches far past the event's end.
    const shortFullyContained = makeIntent({
      startTime: new Date(NOW.getTime() + 50 * MIN),
      endTime: new Date(NOW.getTime() + 55 * MIN),
    });
    const longMostlyOutside = makeIntent({
      startTime: new Date(NOW.getTime() + 50 * MIN),
      endTime: new Date(NOW.getTime() + 120 * MIN),
    });

    const containedScore = timeScore(shortFullyContained, event, DEFAULT_CONFIG, NOW);
    const mostlyOutsideScore = timeScore(longMostlyOutside, event, DEFAULT_CONFIG, NOW);

    expect(containedScore).toBeGreaterThan(mostlyOutsideScore);
  });
});
