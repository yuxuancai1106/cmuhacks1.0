/**
 * §A — the LLM budget. This file is the project's central claim under test:
 * semantic intelligence is rare, deterministic matching carries the traffic.
 *
 * Every assertion here is an **exact** call count taken from a counting fake
 * `LlmClient`. Not "few", not "at most" — exact, because a budget that only
 * holds approximately is not a budget.
 */
import { describe, it, expect } from 'vitest';
import { llmCallRatio } from '../../src/index.js';
import { makeEvent } from '../support/factories.js';
import {
  NOVEL_TEXT_A,
  NOVEL_TEXT_B,
  UNMAPPABLE_TEXT,
  asMatched,
  asPending,
  createHarness,
  treadmillIntent,
} from '../support/harness.js';

describe('LLM budget: the deterministic path never calls the model', () => {
  it('makes 0 calls for a button-only request (structured activityIds, no text)', async () => {
    const h = createHarness({ seed: [makeEvent()] });

    const outcome = await h.engine.match('u-button', treadmillIntent());

    expect(h.llm.callCount).toBe(0);
    expect(h.counter('llm.calls')).toBe(0);
    expect(asMatched(outcome).semanticSource).toBe('NONE');
  });

  it('makes 0 calls for text that is itself a controlled-vocabulary id ("treadmill")', async () => {
    const h = createHarness();

    const outcome = asPending(await h.engine.match('u-text', { text: 'treadmill' }));

    expect(h.llm.callCount).toBe(0);
    expect(outcome.semanticSource).toBe('DETERMINISTIC');
    expect(outcome.event.activityId).toBe('treadmill');
  });

  it('makes 0 calls for a known synonym ("gym" -> workout)', async () => {
    const h = createHarness();

    const outcome = asPending(await h.engine.match('u-syn', { text: 'gym' }));

    expect(h.llm.callCount).toBe(0);
    expect(outcome.semanticSource).toBe('DETERMINISTIC');
    expect(outcome.event.activityId).toBe('workout');
  });

  it('routes a punctuation/whitespace variant down the identical deterministic path', async () => {
    const h = createHarness();

    // The clean phrase creates the event...
    const clean = asPending(await h.engine.match('u-clean', { text: 'treadmill' }));
    // ...and the noisy variant must land on that very event, not a second one.
    const noisy = asMatched(await h.engine.match('u-noisy', { text: '  TREADMILL!! ' }));

    expect(h.llm.callCount).toBe(0);
    expect(clean.semanticSource).toBe('DETERMINISTIC');
    expect(noisy.semanticSource).toBe('DETERMINISTIC');
    expect(noisy.eventId).toBe(clean.eventId);
    expect(h.repo.all()).toHaveLength(1);
  });

  it('makes 0 calls for multi-word text containing a known activity token', async () => {
    const h = createHarness();

    const outcome = asPending(
      await h.engine.match('u-multi', { text: 'work on my robotics project' }),
    );

    expect(h.llm.callCount).toBe(0);
    expect(h.counter('semantic.deterministic.hit')).toBe(1);
    expect(outcome.semanticSource).toBe('DETERMINISTIC');
    expect(outcome.event.activityId).toBe('robotics');
  });
});

describe('LLM budget: genuinely novel text costs exactly one call', () => {
  it('calls the model exactly once, with the normalized text', async () => {
    const h = createHarness();

    const outcome = asPending(await h.engine.match('u-novel', { text: NOVEL_TEXT_A }));

    expect(h.llm.callCount).toBe(1);
    expect(h.llm.calls[0]).toBe(NOVEL_TEXT_A);
    expect(outcome.semanticSource).toBe('LLM');
    expect(outcome.event.activityId).toBe('workout');
  });

  it('serves the second submission of the same text from the semantic cache — still 1 call total', async () => {
    const h = createHarness();

    const first = asPending(await h.engine.match('u-a', { text: NOVEL_TEXT_A }));
    const second = await h.engine.match('u-b', { text: NOVEL_TEXT_A });

    expect(h.llm.callCount).toBe(1);
    expect(first.semanticSource).toBe('LLM');
    expect(second.semanticSource).toBe('CACHE');
    expect(h.counter('semantic.cache.hit')).toBe(1);
  });
});

describe('LLM budget: recommend() is structurally incapable of calling the model', () => {
  it('makes 0 calls across a varied batch — including text that match() would escalate', async () => {
    const h = createHarness({ seed: [makeEvent()] });

    await h.engine.recommend(treadmillIntent(), 'u-r1');
    await h.engine.recommend({ text: 'treadmill' }, 'u-r2');
    await h.engine.recommend({ text: 'gym' }, 'u-r3');
    const novel = await h.engine.recommend({ text: NOVEL_TEXT_A }, 'u-r4');
    const unmappable = await h.engine.recommend({ text: UNMAPPABLE_TEXT }, 'u-r5');
    await h.engine.recommend({ activityIds: ['treadmill'], text: NOVEL_TEXT_B }, 'u-r6');

    expect(h.llm.callCount).toBe(0);
    expect(h.counter('llm.calls')).toBe(0);
    // Provably unmappable text yields nothing rather than escalating.
    expect(novel.recommendations).toEqual([]);
    expect(unmappable.recommendations).toEqual([]);

    // The 0 above is not vacuous: the *same* novel text through match() does
    // cost a call, so recommend()'s silence is a property of the path.
    await h.engine.match('u-proof', { text: NOVEL_TEXT_A });
    expect(h.llm.callCount).toBe(1);
  });
});

describe('LLM budget: llmCallRatio over a mixed workload', () => {
  it('reports calls-per-match-request and counts recommend() as free', async () => {
    const h = createHarness({ seed: [makeEvent()] });
    const user = 'u-mixed';

    // 5 match requests the deterministic tier fully serves.
    await h.engine.match(user, treadmillIntent());
    await h.engine.match(user, { text: 'treadmill' });
    await h.engine.match(user, { text: 'gym' });
    await h.engine.match(user, { text: '  TREADMILL!! ' });
    await h.engine.match(user, { text: 'work on my robotics project' });
    // 2 novel phrases -> 1 call each.
    await h.engine.match(user, { text: NOVEL_TEXT_A });
    await h.engine.match(user, { text: NOVEL_TEXT_B });
    // 1 repeat of a novel phrase -> served from the semantic cache, 0 calls.
    await h.engine.match(user, { text: NOVEL_TEXT_A });
    // Recommendations are free and are not match requests at all.
    await h.engine.recommend(treadmillIntent(), user);
    await h.engine.recommend({ text: NOVEL_TEXT_B }, user);

    const snapshot = h.snapshot();
    expect(snapshot.counters['match.requests']).toBe(8);
    expect(snapshot.counters['llm.calls']).toBe(2);
    expect(h.llm.callCount).toBe(2);
    expect(llmCallRatio(snapshot)).toBeCloseTo(2 / 8, 10);
  });
});
