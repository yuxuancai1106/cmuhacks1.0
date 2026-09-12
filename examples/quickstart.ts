/**
 * Runnable end-to-end example: `npm run example`
 *
 * Uses the in-memory reference repository, so it needs no database and no
 * API key. Every call below is deterministic and makes zero LLM calls.
 */
import {
  createMatchingEngine,
  createInMemoryEventRepository,
  createInMemoryMetrics,
  llmCallRatio,
} from '../src/index.js';

const metrics = createInMemoryMetrics();
const engine = createMatchingEngine({
  events: createInMemoryEventRepository(),
  metrics,
});

// 1. Alice wants a treadmill. Nothing compatible exists, so a new event is
//    created and she becomes its first participant.
const alice = await engine.match('alice', { activityIds: ['treadmill'] });
// `match` returns MATCHED | PENDING | REJECTED. REJECTED carries no event, so
// the compiler makes you handle it before touching one — narrow, don't assume.
if (alice.status === 'REJECTED') throw new Error(`alice rejected: ${alice.reason}`);
console.log('alice:', alice.status, '->', alice.event.id);

// 2. Bob types "gym". That is a synonym, resolved deterministically, so this
//    costs no LLM call — and he is joined to Alice's existing event.
const bob = await engine.match('bob', { text: 'gym' });
if (bob.status === 'REJECTED') throw new Error(`bob rejected: ${bob.reason}`);
console.log('bob:  ', bob.status, '->', bob.event.id);
console.log('       same event as alice:', bob.event.id === alice.event.id);

// 3. The advisory path: what could Carol join right now? Read-only, and
//    structurally incapable of calling an LLM.
const carol = await engine.recommend({ activityIds: ['treadmill'] }, 'carol');
console.log('carol sees:', carol.recommendations.length, 'joinable event(s)');
for (const rec of carol.recommendations) {
  console.log(`       ${rec.eventId}  score=${rec.score.toFixed(3)}`);
}

// 4. The headline metric the whole design optimizes for.
const snap = metrics.snapshot();
console.log('\nLLM calls:', snap.counters['llm.calls'] ?? 0);
console.log('LLM calls / match request:', llmCallRatio(snap));
