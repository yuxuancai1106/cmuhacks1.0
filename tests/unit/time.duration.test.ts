import { describe, it, expect } from 'vitest';
import { resolveDuration, MAX_DURATION_MINUTES } from '../../src/time/duration.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

describe('resolveDuration', () => {
  it('uses a valid explicit duration first', () => {
    expect(resolveDuration('treadmill', 100, DEFAULT_CONFIG)).toBe(100);
  });

  it('caps an explicit duration at MAX_DURATION_MINUTES', () => {
    expect(resolveDuration('treadmill', 10_000, DEFAULT_CONFIG)).toBe(MAX_DURATION_MINUTES);
  });

  it.each([0, -5, NaN, Infinity, -Infinity])(
    'treats an invalid explicit duration (%p) as absent and falls through',
    (invalid) => {
      expect(resolveDuration('treadmill', invalid, DEFAULT_CONFIG)).toBe(
        DEFAULT_CONFIG.activityDurationsMinutes.treadmill,
      );
    },
  );

  it('falls back to the configured per-activity duration when no explicit value is given', () => {
    expect(resolveDuration('basketball', undefined, DEFAULT_CONFIG)).toBe(
      DEFAULT_CONFIG.activityDurationsMinutes.basketball,
    );
  });

  it('falls back to the global default when the activity has no configured duration', () => {
    expect(resolveDuration('some-unconfigured-activity', undefined, DEFAULT_CONFIG)).toBe(
      DEFAULT_CONFIG.defaultDurationMinutes,
    );
  });

  it('falls back to the global default when neither an activity id nor an explicit duration is given', () => {
    expect(resolveDuration(undefined, undefined, DEFAULT_CONFIG)).toBe(
      DEFAULT_CONFIG.defaultDurationMinutes,
    );
  });

  it('never throws', () => {
    expect(() => resolveDuration(undefined, NaN, DEFAULT_CONFIG)).not.toThrow();
  });
});
