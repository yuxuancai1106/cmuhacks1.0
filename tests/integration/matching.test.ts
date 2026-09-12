/**
 * §B — the core matching path through `createMatchingEngine().match`.
 *
 * Joining, creating, the threshold boundary, and the REJECTED outcome. The
 * threshold cases are driven by *configuring the threshold*, never by nudging
 * event fields until a number happens to land on the right side.
 */
import { describe, it, expect } from 'vitest';
import { makeEvent } from '../support/factories.js';
import {
  NOVEL_TEXT_A,
  UNMAPPABLE_TEXT,
  asMatched,
  asPending,
  asRejected,
  createHarness,
  treadmillIntent,
} from '../support/harness.js';

describe('match(): joining an existing compatible event', () => {
  it('joins a seeded open event above threshold and the repository reflects it', async () => {
    const h = createHarness({ seed: [makeEvent()] });

    const outcome = asMatched(await h.engine.match('user-joiner', treadmillIntent()));

    expect(outcome.eventId).toBe('event-1');
    expect(outcome.score).toBeGreaterThanOrEqual(h.engine.config.matchThreshold);
    expect(outcome.event.participantCount).toBe(2);

    // The authoritative view, re-read from the repository rather than from
    // the outcome the engine handed back.
    const stored = h.repo.all();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.participantCount).toBe(2);
    expect(stored[0]?.participantIds).toEqual(['user-creator', 'user-joiner']);

    expect(h.counter('match.matched')).toBe(1);
    expect(h.counter('event.created')).toBe(0);
  });
});

describe('match(): creating a new event when nothing is compatible', () => {
  it('creates a PENDING event with the creator enrolled, discoverable by the next user', async () => {
    const h = createHarness();

    const created = asPending(await h.engine.match('user-a', treadmillIntent()));

    const stored = h.repo.all();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe(created.eventId);
    expect(stored[0]?.status).toBe('OPEN');
    expect(stored[0]?.creatorId).toBe('user-a');
    expect(stored[0]?.participantCount).toBe(1);
    expect(stored[0]?.participantIds).toEqual(['user-a']);
    expect(h.counter('event.created')).toBe(1);
    expect(h.counter('match.pending')).toBe(1);

    // Immediately discoverable — no rebuild, no cache warm-up, no delay.
    const advisory = await h.engine.recommend(treadmillIntent(), 'user-b');
    expect(advisory.recommendations.map((r) => r.eventId)).toEqual([created.eventId]);

    const joined = asMatched(await h.engine.match('user-b', treadmillIntent()));
    expect(joined.eventId).toBe(created.eventId);
    expect(h.repo.all()).toHaveLength(1);
    expect(h.repo.all()[0]?.participantIds).toEqual(['user-a', 'user-b']);
  });
});

describe('match(): the matchThreshold boundary, in both directions', () => {
  /** The score the seeded event actually earns, read from a probe run. */
  async function candidateScore(): Promise<number> {
    const probe = createHarness({ seed: [makeEvent()] });
    return asMatched(await probe.engine.match('user-probe', treadmillIntent())).score;
  }

  it('does NOT join a compatible candidate when the threshold is raised above its score', async () => {
    const h = createHarness({ seed: [makeEvent()], config: { matchThreshold: 0.99 } });

    const outcome = asPending(await h.engine.match('user-joiner', treadmillIntent()));

    // A candidate existed and was good — it simply did not clear the bar.
    expect(outcome.bestRejectedScore).toBeGreaterThan(0.7);
    expect(outcome.bestRejectedScore).toBeLessThan(0.99);

    const stored = h.repo.all();
    expect(stored).toHaveLength(2);
    const seeded = stored.find((e) => e.id === 'event-1');
    expect(seeded?.participantCount).toBe(1);
    expect(seeded?.participantIds).toEqual(['user-creator']);
    expect(h.counter('match.matched')).toBe(0);
    expect(h.counter('event.created')).toBe(1);
  });

  it('joins when the threshold is exactly the candidate score (>= is inclusive)', async () => {
    const score = await candidateScore();
    const h = createHarness({ seed: [makeEvent()], config: { matchThreshold: score } });

    const outcome = asMatched(await h.engine.match('user-joiner', treadmillIntent()));

    expect(outcome.eventId).toBe('event-1');
    expect(outcome.score).toBe(score);
    expect(h.repo.all()).toHaveLength(1);
  });

  it('creates instead of joining when the threshold sits one epsilon above that score', async () => {
    const score = await candidateScore();
    const h = createHarness({ seed: [makeEvent()], config: { matchThreshold: score + 1e-6 } });

    const outcome = asPending(await h.engine.match('user-joiner', treadmillIntent()));

    expect(outcome.bestRejectedScore).toBe(score);
    expect(h.repo.all()).toHaveLength(2);
    expect(h.repo.all().find((e) => e.id === 'event-1')?.participantCount).toBe(1);
  });

  it('joins a candidate that the default threshold rejects once the threshold is lowered', async () => {
    // A deliberately mediocre candidate: same category and same window, but a
    // different activity (basketball is only SAME_CATEGORY to treadmill), so
    // it is retrievable and survives hard filtering yet lands below 0.70.
    const mediocre = makeEvent({
      id: 'event-mediocre',
      activityId: 'basketball',
      tags: ['basketball', 'sports', 'workout'],
    });

    const strict = createHarness({ seed: [mediocre] });
    const rejected = asPending(await strict.engine.match('user-joiner', treadmillIntent()));
    expect(rejected.bestRejectedScore).toBeLessThan(0.7);

    const lenient = createHarness({ seed: [mediocre], config: { matchThreshold: 0.4 } });
    const joined = asMatched(await lenient.engine.match('user-joiner', treadmillIntent()));
    expect(joined.eventId).toBe('event-mediocre');
    expect(lenient.repo.all()).toHaveLength(1);
  });
});

describe('match(): merging free text with structured selections (§23)', () => {
  it('lets a structured activity selection beat a conflicting LLM interpretation, unioning tags', async () => {
    const h = createHarness({
      llmResponse: () => ({
        canonicalActivity: 'basketball',
        category: 'fitness',
        tags: ['hoops', 'outdoors'],
        confidence: 0.95,
      }),
    });

    const outcome = asPending(
      await h.engine.match('user-a', { activityIds: ['treadmill'], text: NOVEL_TEXT_A }),
    );

    // The tap decides the activity...
    expect(outcome.event.activityId).toBe('treadmill');
    expect(outcome.event.categoryId).toBe('fitness');
    expect(outcome.semanticSource).toBe('LLM');
    // ...but the prose still contributes colour.
    expect(outcome.event.tags).toContain('treadmill');
    expect(outcome.event.tags).toContain('hoops');
    expect(outcome.event.tags).toContain('outdoors');
  });

  it('lets the interpretation supply the activity when no button was pressed', async () => {
    const h = createHarness({
      llmResponse: () => ({
        canonicalActivity: 'basketball',
        category: 'nonsense-the-model-invented',
        tags: ['hoops'],
        confidence: 0.95,
      }),
    });

    const outcome = asPending(await h.engine.match('user-a', { text: NOVEL_TEXT_A }));

    expect(outcome.event.activityId).toBe('basketball');
    // The category always comes from the taxonomy, never from the model.
    expect(outcome.event.categoryId).toBe('fitness');
  });
});

describe('match(): REJECTED — nothing resolves to the controlled vocabulary', () => {
  it('rejects unmappable free text with no LLM configured, creating nothing', async () => {
    const h = createHarness({ withoutLlm: true });

    const outcome = asRejected(await h.engine.match('user-a', { text: UNMAPPABLE_TEXT }));

    expect(outcome).toEqual({
      status: 'REJECTED',
      reason: 'NO_RESOLVABLE_ACTIVITY',
      semanticSource: 'FALLBACK',
    });
    expect(h.repo.all()).toEqual([]);
    expect(h.counter('match.rejected')).toBe(1);
    expect(h.counter('event.created')).toBe(0);
  });

  it('rejects when the LLM answers with junk the schema validator refuses', async () => {
    const h = createHarness({ llmResponse: () => ({ nonsense: true, confidence: 'high' }) });

    const outcome = asRejected(await h.engine.match('user-a', { text: UNMAPPABLE_TEXT }));

    expect(outcome.reason).toBe('NO_RESOLVABLE_ACTIVITY');
    expect(outcome.semanticSource).toBe('FALLBACK');
    expect(h.llm.callCount).toBe(1);
    expect(h.counter('llm.errors')).toBe(1);
    expect(h.repo.all()).toEqual([]);
  });

  it('rejects an intent whose only structured activity id is not in the vocabulary', async () => {
    const h = createHarness();

    const outcome = asRejected(await h.engine.match('user-a', { activityIds: ['not-a-real-thing'] }));

    expect(outcome.reason).toBe('NO_RESOLVABLE_ACTIVITY');
    expect(outcome.semanticSource).toBe('NONE');
    expect(h.llm.callCount).toBe(0);
    expect(h.repo.all()).toEqual([]);
  });
});
