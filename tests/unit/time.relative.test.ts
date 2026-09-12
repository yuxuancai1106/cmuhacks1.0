import { describe, it, expect } from 'vitest';
import { parseRelativeTime, stripTimePhrases, DAY_PART_HOUR_OF_DAY } from '../../src/time/relative.js';

const MIN = 60_000;

/** Builds a local Date for a fixed day so day-part/clock resolution is deterministic. */
function localAt(hour: number, minute = 0): Date {
  return new Date(2026, 8, 12, hour, minute, 0, 0); // 2026-09-12, local time
}

describe('parseRelativeTime — now/asap', () => {
  it.each(['now', 'right now', 'asap', 'ASAP'])('resolves "%s" to the current instant', (phrase) => {
    const now = localAt(10, 0);
    expect(parseRelativeTime(phrase, now)?.startTime.getTime()).toBe(now.getTime());
  });
});

describe('parseRelativeTime — in N minutes/hours', () => {
  it('resolves "in 30 minutes"', () => {
    const now = localAt(10, 0);
    expect(parseRelativeTime('in 30 minutes', now)?.startTime.getTime()).toBe(now.getTime() + 30 * MIN);
  });

  it('resolves "in an hour" to +60 minutes', () => {
    const now = localAt(10, 0);
    expect(parseRelativeTime('in an hour', now)?.startTime.getTime()).toBe(now.getTime() + 60 * MIN);
  });

  it('resolves "in 2.5 hours"', () => {
    const now = localAt(10, 0);
    expect(parseRelativeTime('in 2.5 hours', now)?.startTime.getTime()).toBe(now.getTime() + 150 * MIN);
  });
});

describe('parseRelativeTime — at <clock time>', () => {
  it('resolves a bare hour with no am/pm as literal 24-hour time (not evening)', () => {
    const now = localAt(6, 0);
    const result = parseRelativeTime('at 7', now);
    expect(result?.startTime.getTime()).toBe(localAt(7, 0).getTime());
  });

  it('resolves "at 7pm" to today when that time has not yet passed', () => {
    const now = localAt(10, 0);
    const result = parseRelativeTime('at 7pm', now);
    expect(result?.startTime.getTime()).toBe(localAt(19, 0).getTime());
  });

  it('rolls over to tomorrow when the named clock time has already passed today', () => {
    const now = localAt(14, 0);
    const result = parseRelativeTime('at 7am', now);
    const tomorrowAt7 = new Date(2026, 8, 13, 7, 0, 0, 0);
    expect(result?.startTime.getTime()).toBe(tomorrowAt7.getTime());
  });

  it('resolves 24-hour "at 19:30" notation', () => {
    const now = localAt(10, 0);
    const result = parseRelativeTime('at 19:30', now);
    expect(result?.startTime.getTime()).toBe(localAt(19, 30).getTime());
  });

  it('rejects an out-of-range hour for a given meridiem', () => {
    const now = localAt(10, 0);
    // "13pm" is invalid; with no other recognizable phrase, nothing matches.
    expect(parseRelativeTime('at 13pm', now)).toBeNull();
  });
});

describe('parseRelativeTime — vague day parts', () => {
  it.each([
    ['tonight', DAY_PART_HOUR_OF_DAY.night, 0],
    ['this evening', DAY_PART_HOUR_OF_DAY.evening, 0],
    ['this afternoon', DAY_PART_HOUR_OF_DAY.afternoon, 0],
    ['this morning', DAY_PART_HOUR_OF_DAY.morning, 0],
    ['tomorrow morning', DAY_PART_HOUR_OF_DAY.morning, 1],
  ] as const)('resolves "%s"', (phrase, hour, dayOffset) => {
    const now = localAt(8, 0);
    const result = parseRelativeTime(phrase, now);
    const expected = new Date(2026, 8, 12 + dayOffset, hour, 0, 0, 0);
    expect(result?.startTime.getTime()).toBe(expected.getTime());
  });
});

describe('parseRelativeTime — precedence and no-match', () => {
  it('prefers now/asap over an explicit clock time in the same text', () => {
    const now = localAt(10, 0);
    const result = parseRelativeTime('asap, or at 7pm if not', now);
    expect(result?.startTime.getTime()).toBe(now.getTime());
  });

  it('prefers "in N minutes" over an "at <clock>" phrase in the same text', () => {
    const now = localAt(10, 0);
    const result = parseRelativeTime('in 30 minutes at 7pm', now);
    expect(result?.startTime.getTime()).toBe(now.getTime() + 30 * MIN);
  });

  it('returns null when no recognizable time phrase is present', () => {
    expect(parseRelativeTime('lets just hang out sometime', localAt(10, 0))).toBeNull();
  });
});

describe('stripTimePhrases', () => {
  it('strips a trailing time phrase', () => {
    expect(stripTimePhrases('treadmill in 30 minutes')).toBe('treadmill');
  });

  it('strips a leading time phrase', () => {
    expect(stripTimePhrases('in 30 minutes treadmill')).toBe('treadmill');
  });

  it('leaves a time-like phrase in the middle of the text untouched', () => {
    const text = "let's meet at 7 downtown";
    expect(stripTimePhrases(text)).toBe(text);
  });

  it('returns an empty string for empty input', () => {
    expect(stripTimePhrases('')).toBe('');
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(stripTimePhrases('   ')).toBe('');
  });
});
