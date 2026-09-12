import { describe, it, expect } from 'vitest';
import { createInMemoryEventRepository } from '../../src/adapters/inMemoryEventRepository.js';
import type { CandidateQuery, EventDraft } from '../../src/core/types.js';
import { makeEvent, NOW } from '../../tests/support/factories.js';

function baseQuery(overrides: Partial<CandidateQuery> = {}): CandidateQuery {
  return {
    activityIds: ['treadmill'],
    categoryIds: [],
    locationIds: [],
    windowStart: new Date(NOW.getTime() - 60 * 60_000),
    windowEnd: new Date(NOW.getTime() + 60 * 60_000),
    now: NOW,
    limit: 100,
    ...overrides,
  };
}

describe('findCandidates — expired-event filtering', () => {
  it('never returns an event whose expiresAt is at or before now', async () => {
    const repo = createInMemoryEventRepository({
      seed: [makeEvent({ id: 'expired', expiresAt: NOW }), makeEvent({ id: 'alive' })],
    });
    const results = await repo.findCandidates(baseQuery());
    expect(results.map((e) => e.id)).not.toContain('expired');
    expect(results.map((e) => e.id)).toContain('alive');
  });
});

describe('findCandidates — capacity filtering', () => {
  it('never returns a full event', async () => {
    const repo = createInMemoryEventRepository({
      seed: [
        makeEvent({ id: 'full', capacity: 4, participantCount: 4 }),
        makeEvent({ id: 'has-room', capacity: 4, participantCount: 3 }),
      ],
    });
    const results = await repo.findCandidates(baseQuery());
    expect(results.map((e) => e.id)).not.toContain('full');
    expect(results.map((e) => e.id)).toContain('has-room');
  });
});

describe('findCandidates — status filtering', () => {
  it('only returns OPEN events', async () => {
    const repo = createInMemoryEventRepository({
      seed: [
        makeEvent({ id: 'matched', status: 'MATCHED' }),
        makeEvent({ id: 'cancelled', status: 'CANCELLED' }),
        makeEvent({ id: 'open', status: 'OPEN' }),
      ],
    });
    const results = await repo.findCandidates(baseQuery());
    expect(results.map((e) => e.id)).toEqual(['open']);
  });
});

describe('findCandidates — other query predicates', () => {
  it('matches on activity or category id', async () => {
    const repo = createInMemoryEventRepository({
      seed: [
        makeEvent({ id: 'by-activity', activityId: 'treadmill', categoryId: 'fitness' }),
        makeEvent({ id: 'by-category', activityId: 'basketball', categoryId: 'fitness' }),
        makeEvent({ id: 'neither', activityId: 'painting', categoryId: 'art' }),
      ],
    });
    const results = await repo.findCandidates(
      baseQuery({ activityIds: ['treadmill'], categoryIds: ['fitness'] }),
    );
    expect(results.map((e) => e.id).sort()).toEqual(['by-activity', 'by-category']);
  });

  it('excludes events created or joined by excludeUserId', async () => {
    const repo = createInMemoryEventRepository({
      seed: [
        makeEvent({ id: 'own', creatorId: 'user-1' }),
        makeEvent({ id: 'joined', participantIds: ['user-1', 'user-creator'] }),
        makeEvent({ id: 'unrelated' }),
      ],
    });
    const results = await repo.findCandidates(baseQuery({ excludeUserId: 'user-1' }));
    expect(results.map((e) => e.id)).toEqual(['unrelated']);
  });

  it('respects the limit', async () => {
    const repo = createInMemoryEventRepository({
      seed: [makeEvent({ id: 'a' }), makeEvent({ id: 'b' }), makeEvent({ id: 'c' })],
    });
    const results = await repo.findCandidates(baseQuery({ limit: 2 }));
    expect(results.length).toBe(2);
  });
});

describe('joinEventAtomically — concurrent final-slot joins', () => {
  it('lets exactly one of two concurrent joins for the last slot succeed, and never exceeds capacity', async () => {
    const repo = createInMemoryEventRepository({
      seed: [
        makeEvent({
          id: 'last-slot',
          capacity: 4,
          participantCount: 3,
          participantIds: ['p1', 'p2', 'p3'],
        }),
      ],
    });

    const [resultA, resultB] = await Promise.all([
      repo.joinEventAtomically('last-slot', 'racer-a', NOW),
      repo.joinEventAtomically('last-slot', 'racer-b', NOW),
    ]);

    const outcomes = [resultA, resultB];
    const succeeded = outcomes.filter((r) => r.ok === true);
    const failed = outcomes.filter((r) => r.ok === false);

    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);

    const finalEvent = repo.all().find((e) => e.id === 'last-slot');
    expect(finalEvent?.participantCount).toBe(4);
  });

  /**
   * KNOWN SRC DISCREPANCY (reported, not worked around): the brief's spec
   * requires the losing racer for the final slot to receive
   * `{ ok: false, reason: 'FULL' }`. `joinEventAtomically` in
   * `src/adapters/inMemoryEventRepository.ts` checks `status !== 'OPEN'`
   * before it checks capacity, and the winning join's own write flips
   * `status` to `'MATCHED'` the instant capacity is reached (same
   * synchronous update). So the loser's `status !== 'OPEN'` check now reads
   * `true` and it is rejected with `NOT_OPEN`, and the `FULL` branch is
   * never reached for this exact scenario. This assertion intentionally
   * encodes the spec's stated expectation and is left failing rather than
   * weakened to match the current behaviour -- see the final report for the
   * suggested fix (check capacity before status, or don't flip status
   * inside the same conditional write).
   */
  it('reports FULL (not NOT_OPEN) to the loser of a final-slot race', async () => {
    const repo = createInMemoryEventRepository({
      seed: [
        makeEvent({
          id: 'last-slot',
          capacity: 4,
          participantCount: 3,
          participantIds: ['p1', 'p2', 'p3'],
        }),
      ],
    });

    const [resultA, resultB] = await Promise.all([
      repo.joinEventAtomically('last-slot', 'racer-a', NOW),
      repo.joinEventAtomically('last-slot', 'racer-b', NOW),
    ]);

    const loser = [resultA, resultB].find((r) => r.ok === false);
    expect(loser).toEqual({ ok: false, reason: 'FULL' });
  });

  it('flips the event to MATCHED once capacity is reached', async () => {
    const repo = createInMemoryEventRepository({
      seed: [
        makeEvent({
          id: 'last-slot',
          capacity: 4,
          participantCount: 3,
          participantIds: ['p1', 'p2', 'p3'],
        }),
      ],
    });
    await repo.joinEventAtomically('last-slot', 'racer-a', NOW);
    const finalEvent = repo.all().find((e) => e.id === 'last-slot');
    expect(finalEvent?.status).toBe('MATCHED');
  });
});

describe('joinEventAtomically — duplicate participation prevention', () => {
  it('rejects a second join by the same user without incrementing the count', async () => {
    const repo = createInMemoryEventRepository({
      seed: [makeEvent({ id: 'event-1', capacity: 6, participantCount: 1, participantIds: ['user-creator'] })],
    });

    const first = await repo.joinEventAtomically('event-1', 'user-2', NOW);
    expect(first.ok).toBe(true);

    const second = await repo.joinEventAtomically('event-1', 'user-2', NOW);
    expect(second).toEqual({ ok: false, reason: 'ALREADY_PARTICIPANT' });

    const finalEvent = repo.all().find((e) => e.id === 'event-1');
    expect(finalEvent?.participantCount).toBe(2);
  });
});

describe('joinEventAtomically — other rejection reasons', () => {
  it('returns NOT_FOUND for an unknown event id', async () => {
    const repo = createInMemoryEventRepository();
    const result = await repo.joinEventAtomically('does-not-exist', 'user-1', NOW);
    expect(result).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('returns EXPIRED for an event past its matching window', async () => {
    const repo = createInMemoryEventRepository({
      seed: [makeEvent({ id: 'expired', expiresAt: new Date(NOW.getTime() - 1000) })],
    });
    const result = await repo.joinEventAtomically('expired', 'user-1', NOW);
    expect(result).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it('returns NOT_OPEN for a non-OPEN event', async () => {
    const repo = createInMemoryEventRepository({
      seed: [makeEvent({ id: 'matched', status: 'MATCHED' })],
    });
    const result = await repo.joinEventAtomically('matched', 'user-1', NOW);
    expect(result).toEqual({ ok: false, reason: 'NOT_OPEN' });
  });
});

describe('createEvent', () => {
  it('atomically enrolls the creator as the first participant', async () => {
    const repo = createInMemoryEventRepository();
    const draft: EventDraft = {
      creatorId: 'user-1',
      activityId: 'treadmill',
      categoryId: 'fitness',
      tags: ['treadmill'],
      startTime: new Date(NOW.getTime() + 30 * 60_000),
      endTime: new Date(NOW.getTime() + 90 * 60_000),
      locationId: 'loc-a',
      capacity: 6,
      status: 'OPEN',
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 120 * 60_000),
    };
    const created = await repo.createEvent(draft);
    expect(created.participantCount).toBe(1);
    expect(created.participantIds).toEqual(['user-1']);
  });

  it('makes the new event immediately visible to findCandidates', async () => {
    const repo = createInMemoryEventRepository();
    const draft: EventDraft = {
      creatorId: 'user-1',
      activityId: 'treadmill',
      categoryId: 'fitness',
      tags: ['treadmill'],
      startTime: new Date(NOW.getTime() + 30 * 60_000),
      endTime: new Date(NOW.getTime() + 90 * 60_000),
      locationId: 'loc-a',
      capacity: 6,
      status: 'OPEN',
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 120 * 60_000),
    };
    const created = await repo.createEvent(draft);
    const results = await repo.findCandidates(baseQuery());
    expect(results.map((e) => e.id)).toContain(created.id);
  });
});
