import { describe, it, expect } from 'vitest';
import { tagScore } from '../../src/scoring/tags.js';

describe('tagScore', () => {
  it("scores the spec's worked example above plain Jaccard", () => {
    const intentTags = ['treadmill', 'cardio', 'running'];
    const eventTags = ['treadmill', 'workout', 'cardio'];

    // intersection = {treadmill, cardio} (2), union = 4 distinct tags.
    const plainJaccard = 2 / 4;
    const score = tagScore(intentTags, eventTags);

    // The blended score rewards intent coverage in addition to plain
    // Jaccard, so an event satisfying 2/3 of the intent's tags should not
    // read as merely "mediocre" (0.5) the way plain Jaccard alone would.
    expect(score).toBeGreaterThan(plainJaccard);
    expect(score).toBeCloseTo(0.5 * plainJaccard + 0.5 * (2 / 3), 10);
  });

  it('scores 1.0 when the tag sets are identical', () => {
    expect(tagScore(['treadmill', 'cardio'], ['treadmill', 'cardio'])).toBeCloseTo(1.0, 10);
  });

  it('scores 0 when the intent has no tags', () => {
    expect(tagScore([], ['treadmill', 'cardio'])).toBe(0);
  });

  it('scores 0 when the event has no tags', () => {
    expect(tagScore(['treadmill', 'cardio'], [])).toBe(0);
  });

  it('scores 0 when both tag lists are empty', () => {
    expect(tagScore([], [])).toBe(0);
  });

  it('scores 0 for completely disjoint tag sets', () => {
    expect(tagScore(['treadmill', 'cardio'], ['painting', 'sketch'])).toBe(0);
  });

  it('is insensitive to the order of the tags', () => {
    const a = tagScore(['treadmill', 'cardio', 'running'], ['workout', 'cardio', 'treadmill']);
    const b = tagScore(['running', 'cardio', 'treadmill'], ['treadmill', 'workout', 'cardio']);
    expect(a).toBe(b);
  });

  it('de-duplicates repeated tags on both sides', () => {
    const withDupes = tagScore(
      ['treadmill', 'treadmill', 'cardio'],
      ['treadmill', 'cardio', 'cardio', 'cardio'],
    );
    const deduped = tagScore(['treadmill', 'cardio'], ['treadmill', 'cardio']);
    expect(withDupes).toBe(deduped);
  });
});
