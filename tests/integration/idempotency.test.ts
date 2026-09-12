/**
 * §26 — duplicate submissions and duplicate participation.
 *
 * Two distinct guarantees that both amount to "a retry must not create a
 * second thing": an explicit `idempotencyKey` replays a stored outcome, and
 * even *without* a key a user can never end up in one event twice.
 */
import { describe, it, expect } from 'vitest';
import { createInMemoryIdempotencyStore, fixedClock } from '../../src/index.js';
import type { MatchableEvent } from '../../src/core/types.js';
import { makeEvent, NOW } from '../support/factories.js';
import {
  UNMAPPABLE_TEXT,
  asMatched,
  asPending,
  asRejected,
  createHarness,
  treadmillIntent,
} from '../support/harness.js';

function idempotencyStore() {
  return createInMemoryIdempotencyStore({ clock: fixedClock(NOW) });
}

/** Every user id that appears more than once in one event's participant list. */
function duplicateParticipants(event: MatchableEvent): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const id of event.participantIds ?? []) {
    if (seen.has(id)) duplicates.push(id);
    seen.add(id);
  }
  return duplicates;
}

describe('§26 duplicate submissions: the same idempotencyKey', () => {
  it('creates exactly one event and replays the outcome on the second submission', async () => {
    const h = createHarness({ idempotency: idempotencyStore() });
    const intent = treadmillIntent({ idempotencyKey: 'key-create' });

    const first = asPending(await h.engine.match('user-a', intent));
    const second = asPending(await h.engine.match('user-a', intent));

    expect(h.repo.all()).toHaveLength(1);
    expect(second.eventId).toBe(first.eventId);
    expect(second.idempotentReplay).toBe(true);
    expect(first.idempotentReplay).toBeUndefined();
    expect(h.counter('event.created')).toBe(1);
    // A replay is still a request that was served without an LLM call.
    expect(h.counter('match.requests')).toBe(2);
  });

  it('replays a MATCHED outcome without joining the event a second time', async () => {
    const h = createHarness({ seed: [makeEvent()], idempotency: idempotencyStore() });
    const intent = treadmillIntent({ idempotencyKey: 'key-join' });

    const first = asMatched(await h.engine.match('user-joiner', intent));
    const second = asMatched(await h.engine.match('user-joiner', intent));

    expect(second.eventId).toBe(first.eventId);
    expect(second.idempotentReplay).toBe(true);
    const stored = h.repo.all();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.participantCount).toBe(2);
    expect(duplicateParticipants(stored[0] ?? makeEvent())).toEqual([]);
  });

  it('never replays a REJECTED outcome — a retry is free to resolve differently', async () => {
    const h = createHarness({ withoutLlm: true, idempotency: idempotencyStore() });

    const first = asRejected(
      await h.engine.match('user-a', { text: UNMAPPABLE_TEXT, idempotencyKey: 'key-rejected' }),
    );
    const second = asRejected(
      await h.engine.match('user-a', { text: UNMAPPABLE_TEXT, idempotencyKey: 'key-rejected' }),
    );

    expect(first.reason).toBe('NO_RESOLVABLE_ACTIVITY');
    expect(second.reason).toBe('NO_RESOLVABLE_ACTIVITY');
    expect(h.repo.all()).toEqual([]);

    // The decisive assertion: reusing that key with a resolvable intent must
    // produce a real outcome, not a replay of the rejection.
    const retry = asPending(
      await h.engine.match('user-a', treadmillIntent({ idempotencyKey: 'key-rejected' })),
    );
    expect(retry.idempotentReplay).toBeUndefined();
    expect(h.repo.all()).toHaveLength(1);
  });
});

describe('§26 duplicate participation: repeated match() without an idempotency key', () => {
  it('never enrolls a user in the same event twice', async () => {
    const h = createHarness({ seed: [makeEvent()] });

    const first = asMatched(await h.engine.match('user-joiner', treadmillIntent()));
    const second = asPending(await h.engine.match('user-joiner', treadmillIntent()));
    const third = await h.engine.match('user-joiner', treadmillIntent());

    expect(first.eventId).toBe('event-1');
    // The user is already in event-1, so it is no longer a candidate for them.
    expect(second.eventId).not.toBe('event-1');
    expect(third.status).not.toBe('MATCHED');

    const stored = h.repo.all();
    const seeded = stored.find((e) => e.id === 'event-1');
    expect(seeded?.participantIds).toEqual(['user-creator', 'user-joiner']);
    expect(seeded?.participantCount).toBe(2);
    for (const event of stored) {
      expect(duplicateParticipants(event)).toEqual([]);
    }
  });
});
