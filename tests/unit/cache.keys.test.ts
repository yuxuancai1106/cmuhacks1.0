import { describe, it, expect } from 'vitest';
import { semanticKey, recommendationKey, suggestionsKey } from '../../src/cache/keys.js';

const BUCKET_MS = 5 * 60 * 1000;

describe('recommendationKey — order insensitivity', () => {
  it('produces the same key regardless of activity id order', () => {
    const now = new Date('2026-09-12T12:00:00.000Z');
    const a = recommendationKey({
      activityIds: ['treadmill', 'workout', 'running'],
      categoryIds: [],
      locationIds: [],
      now,
      bucketMs: BUCKET_MS,
    });
    const b = recommendationKey({
      activityIds: ['running', 'treadmill', 'workout'],
      categoryIds: [],
      locationIds: [],
      now,
      bucketMs: BUCKET_MS,
    });
    expect(a).toBe(b);
  });

  it('produces the same key regardless of category/location id order', () => {
    const now = new Date('2026-09-12T12:00:00.000Z');
    const a = recommendationKey({
      activityIds: [],
      categoryIds: ['fitness', 'art'],
      locationIds: ['loc-b', 'loc-a'],
      now,
      bucketMs: BUCKET_MS,
    });
    const b = recommendationKey({
      activityIds: [],
      categoryIds: ['art', 'fitness'],
      locationIds: ['loc-a', 'loc-b'],
      now,
      bucketMs: BUCKET_MS,
    });
    expect(a).toBe(b);
  });
});

describe('recommendationKey — time bucketing', () => {
  it('produces the same key for two timestamps in the same bucket', () => {
    const bucketStart = new Date('2026-09-12T12:00:00.000Z').getTime();
    const t1 = new Date(bucketStart + 10_000); // 10s into the bucket
    const t2 = new Date(bucketStart + BUCKET_MS - 1); // 1ms before the bucket ends
    const args = { activityIds: ['treadmill'], categoryIds: [], locationIds: [] };

    const keyA = recommendationKey({ ...args, startTime: t1, now: t1, bucketMs: BUCKET_MS });
    const keyB = recommendationKey({ ...args, startTime: t2, now: t2, bucketMs: BUCKET_MS });
    expect(keyA).toBe(keyB);
  });

  it('produces a different key for timestamps in adjacent buckets', () => {
    const bucketStart = new Date('2026-09-12T12:00:00.000Z').getTime();
    const t1 = new Date(bucketStart);
    const t2 = new Date(bucketStart + BUCKET_MS); // exactly one bucket later
    const args = { activityIds: ['treadmill'], categoryIds: [], locationIds: [] };

    const keyA = recommendationKey({ ...args, startTime: t1, now: t1, bucketMs: BUCKET_MS });
    const keyB = recommendationKey({ ...args, startTime: t2, now: t2, bucketMs: BUCKET_MS });
    expect(keyA).not.toBe(keyB);
  });

  it('does not embed the raw exact timestamp in the key', () => {
    const now = new Date('2026-09-12T12:00:00.000Z');
    const key = recommendationKey({
      activityIds: ['treadmill'],
      categoryIds: [],
      locationIds: [],
      now,
      bucketMs: BUCKET_MS,
    });
    expect(key).not.toContain(String(now.getTime()));
  });

  it('falls back to `now` for bucketing when the intent has no startTime', () => {
    const now = new Date('2026-09-12T12:00:00.000Z');
    const args = { activityIds: ['treadmill'], categoryIds: [], locationIds: [] };
    const withStart = recommendationKey({ ...args, startTime: now, now, bucketMs: BUCKET_MS });
    const withoutStart = recommendationKey({ ...args, now, bucketMs: BUCKET_MS });
    expect(withoutStart).toBe(withStart);
  });
});

describe('semanticKey', () => {
  it('produces the same key for the same text', () => {
    expect(semanticKey('treadmill')).toBe(semanticKey('treadmill'));
  });

  it('produces different keys for different text', () => {
    expect(semanticKey('treadmill')).not.toBe(semanticKey('basketball'));
  });

  it('bounds unboundedly long text so the key stays short', () => {
    const longText = 'a'.repeat(5000);
    const key = semanticKey(longText);
    expect(key.length).toBeLessThan(200);
  });

  it('does not collide two different long inputs sharing the same truncation prefix', () => {
    const base = 'x'.repeat(100);
    const keyA = semanticKey(`${base}-first-tail`);
    const keyB = semanticKey(`${base}-second-tail`);
    expect(keyA).not.toBe(keyB);
  });
});

describe('suggestionsKey', () => {
  it('includes the bucket and, when given, the location id', () => {
    const withLocation = suggestionsKey('user-1', 42, 'loc-a');
    const withoutLocation = suggestionsKey('user-1', 42);
    expect(withLocation).not.toBe(withoutLocation);
    expect(withoutLocation).toContain('42');
  });

  it('produces different keys for different users at the same bucket', () => {
    expect(suggestionsKey('user-1', 42)).not.toBe(suggestionsKey('user-2', 42));
  });

  it('produces different keys for different buckets for the same user', () => {
    expect(suggestionsKey('user-1', 1)).not.toBe(suggestionsKey('user-1', 2));
  });
});
