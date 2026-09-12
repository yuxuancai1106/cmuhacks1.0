import { describe, it, expect } from 'vitest';
import { resolveTime } from '../../src/time/resolve.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { AvailabilityService } from '../../src/core/types.js';
import { NOW } from '../../tests/support/factories.js';

const MIN = 60_000;

function slotAvailability(slot: { startTime: Date; endTime: Date } | null): AvailabilityService {
  return {
    async getNextAvailableSlot() {
      return slot;
    },
  };
}

function throwingAvailability(): AvailabilityService {
  return {
    async getNextAvailableSlot() {
      throw new Error('availability service unavailable');
    },
  };
}

/** `activityDurationsMinutes` is index-signature-typed, so lookups are `number | undefined`. */
function configuredDurationMinutes(activityId: string): number {
  const minutes = DEFAULT_CONFIG.activityDurationsMinutes[activityId];
  expect(minutes).toBeDefined();
  return minutes ?? 0;
}

describe('resolveTime — case 1: explicit time', () => {
  it('uses an explicit start/end pair as-is', async () => {
    const start = new Date(NOW.getTime() + 30 * MIN);
    const end = new Date(NOW.getTime() + 90 * MIN);
    const result = await resolveTime({ explicitStart: start, explicitEnd: end, config: DEFAULT_CONFIG, now: NOW });
    expect(result).toEqual({ startTime: start, endTime: end, source: 'EXPLICIT' });
  });

  it('derives the end time from the resolved duration when only a start is given', async () => {
    const start = new Date(NOW.getTime() + 30 * MIN);
    const result = await resolveTime({
      explicitStart: start,
      activityId: 'treadmill',
      config: DEFAULT_CONFIG,
      now: NOW,
    });
    expect(result.source).toBe('EXPLICIT');
    expect(result.startTime).toEqual(start);
    expect(result.endTime.getTime()).toBe(start.getTime() + configuredDurationMinutes('treadmill') * MIN);
  });

  it('falls through to relative-text resolution when the explicit pair is invalid (end <= start)', async () => {
    const start = new Date(NOW.getTime() + 90 * MIN);
    const end = new Date(NOW.getTime() + 30 * MIN); // before start: invalid
    const result = await resolveTime({
      explicitStart: start,
      explicitEnd: end,
      normalizedText: 'in 30 minutes',
      config: DEFAULT_CONFIG,
      now: NOW,
    });
    expect(result.source).toBe('RELATIVE_TEXT');
  });

  it('does not treat an explicit end without an explicit start as "explicit"', async () => {
    const end = new Date(NOW.getTime() + 90 * MIN);
    const result = await resolveTime({ explicitEnd: end, config: DEFAULT_CONFIG, now: NOW });
    expect(result.source).not.toBe('EXPLICIT');
  });
});

describe('resolveTime — case 2: relative text', () => {
  it('resolves a relative phrase and derives the end time from duration', async () => {
    const result = await resolveTime({
      normalizedText: 'in 30 minutes',
      activityId: 'treadmill',
      config: DEFAULT_CONFIG,
      now: NOW,
    });
    expect(result.source).toBe('RELATIVE_TEXT');
    expect(result.startTime.getTime()).toBe(NOW.getTime() + 30 * MIN);
    expect(result.endTime.getTime()).toBe(
      result.startTime.getTime() + configuredDurationMinutes('treadmill') * MIN,
    );
  });
});

describe('resolveTime — case 3: availability, with fallback', () => {
  it("uses the availability service's slot verbatim, including its own end time", async () => {
    const slot = {
      startTime: new Date(NOW.getTime() + 500 * MIN),
      endTime: new Date(NOW.getTime() + 510 * MIN), // a 10-minute slot, unrelated to any resolved duration
    };
    const result = await resolveTime({
      userId: 'user-1',
      availability: slotAvailability(slot),
      config: DEFAULT_CONFIG,
      now: NOW,
    });
    expect(result).toEqual({ startTime: slot.startTime, endTime: slot.endTime, source: 'AVAILABILITY' });
  });

  it('falls back to now + fallbackStartOffsetMinutes when availability returns null', async () => {
    const result = await resolveTime({
      userId: 'user-1',
      availability: slotAvailability(null),
      config: DEFAULT_CONFIG,
      now: NOW,
    });
    expect(result.source).toBe('DEFAULT_FALLBACK');
    expect(result.startTime.getTime()).toBe(NOW.getTime() + DEFAULT_CONFIG.fallbackStartOffsetMinutes * MIN);
    expect(result.endTime.getTime()).toBe(
      result.startTime.getTime() + DEFAULT_CONFIG.defaultDurationMinutes * MIN,
    );
  });

  it('falls back gracefully when the availability service throws', async () => {
    const result = await resolveTime({
      userId: 'user-1',
      availability: throwingAvailability(),
      config: DEFAULT_CONFIG,
      now: NOW,
    });
    expect(result.source).toBe('DEFAULT_FALLBACK');
  });

  it('falls back when availability is configured but no userId is supplied', async () => {
    const result = await resolveTime({
      availability: slotAvailability({ startTime: NOW, endTime: new Date(NOW.getTime() + 60 * MIN) }),
      config: DEFAULT_CONFIG,
      now: NOW,
    });
    expect(result.source).toBe('DEFAULT_FALLBACK');
  });

  it('falls back when nothing else is available at all', async () => {
    const result = await resolveTime({ config: DEFAULT_CONFIG, now: NOW });
    expect(result.source).toBe('DEFAULT_FALLBACK');
    expect(result.startTime.getTime()).toBe(NOW.getTime() + DEFAULT_CONFIG.fallbackStartOffsetMinutes * MIN);
  });

  it('never throws even when the availability service rejects', async () => {
    await expect(
      resolveTime({ userId: 'user-1', availability: throwingAvailability(), config: DEFAULT_CONFIG, now: NOW }),
    ).resolves.toBeDefined();
  });
});
