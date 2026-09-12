import { describe, it, expect } from 'vitest';
import { locationCompatibility } from '../../src/scoring/location.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { makeLocationService } from '../../tests/support/factories.js';

const locations = makeLocationService();

describe('locationCompatibility', () => {
  it('scores 1.0 for the same location', () => {
    expect(locationCompatibility(['loc-a'], 'loc-a', locations, DEFAULT_CONFIG)).toBe(1.0);
  });

  it('scores the nearest band for a nearby location (~33m, inside the 250m band)', () => {
    expect(locationCompatibility(['loc-a'], 'loc-b', locations, DEFAULT_CONFIG)).toBe(0.9);
  });

  it('scores the wider band for a further-but-still-close location (~500m, inside the 800m band)', () => {
    expect(locationCompatibility(['loc-a'], 'loc-c', locations, DEFAULT_CONFIG)).toBe(0.7);
  });

  it('falls back to the same-campus floor beyond every band', () => {
    expect(locationCompatibility(['loc-a'], 'loc-d', locations, DEFAULT_CONFIG)).toBe(
      DEFAULT_CONFIG.location.sameCampus,
    );
  });

  it('scores far (0) for a distant location on a different campus', () => {
    expect(locationCompatibility(['loc-a'], 'loc-e', locations, DEFAULT_CONFIG)).toBe(
      DEFAULT_CONFIG.location.far,
    );
  });

  it('imposes no penalty when the intent carries no location constraint', () => {
    expect(locationCompatibility([], 'loc-e', locations, DEFAULT_CONFIG)).toBe(1);
  });

  it('takes the best (max) compatibility across multiple intent locations', () => {
    // loc-d is same-campus-but-far (0.5) from loc-a; loc-b is very close (0.9).
    const score = locationCompatibility(['loc-d', 'loc-b'], 'loc-a', locations, DEFAULT_CONFIG);
    expect(score).toBe(0.9);
  });

  it('does not throw for an unknown location id and degrades to far', () => {
    expect(() =>
      locationCompatibility(['loc-unknown'], 'loc-a', locations, DEFAULT_CONFIG),
    ).not.toThrow();
    expect(locationCompatibility(['loc-unknown'], 'loc-a', locations, DEFAULT_CONFIG)).toBe(
      DEFAULT_CONFIG.location.far,
    );
  });

  it('treats identical unknown ids as the same location (id equality checked before lookup)', () => {
    expect(locationCompatibility(['loc-unknown'], 'loc-unknown', locations, DEFAULT_CONFIG)).toBe(1.0);
  });
});
