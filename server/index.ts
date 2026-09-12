/**
 * Demo HTTP server — `npm start`.
 *
 * This is a *consumer* of the algorithm, not part of it. The library imposes no
 * framework, so this is deliberately the smallest thing that can drive it:
 * Node's built-in `http`, zero dependencies, and an in-memory repository.
 *
 * NOT production code. There is no authentication — the caller simply asserts a
 * user id — no persistence, and no rate limiting. Auth and storage belong to the
 * surrounding application, which is exactly why they are absent here.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

import {
  createMatchingEngine,
  createInMemoryEventRepository,
  createInMemoryIdempotencyStore,
  createInMemoryMetrics,
  llmCallRatio,
  semanticCacheHitRate,
  recommendationCacheHitRate,
  DEFAULT_TAXONOMY,
  CMU_LOCATIONS,
  createAnthropicLlmClient,
  buildTaxonomyIndex,
  DEFAULT_CONFIG,
  type RawIntent,
  type LlmClient,
  type MatchableEvent,
} from '../src/index.js';

const PORT = Number(process.env['PORT'] ?? 3000);
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * A real LLM is used only when ANTHROPIC_API_KEY is set. Without it the demo
 * still works end to end on the deterministic tier — which is the point of the
 * design, so the fallback is the honest default rather than a crash.
 */
function buildLlmClient(): { llm: LlmClient | undefined; live: boolean } {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (apiKey === undefined || apiKey.length === 0) {
    // Deliberately `undefined` rather than a client that throws. A throwing
    // client would still be *attempted*, so `llm.calls` would tick up and the
    // headline ratio would report calls that never had anywhere to go. With no
    // client, the parser simply stops at its deterministic tier — which is what
    // "the LLM is unavailable" should actually look like.
    return { llm: undefined, live: false };
  }
  const taxonomy = buildTaxonomyIndex(DEFAULT_TAXONOMY, DEFAULT_CONFIG);
  return { llm: createAnthropicLlmClient({ taxonomy, apiKey }), live: true };
}

let repo = createInMemoryEventRepository();
let metrics = createInMemoryMetrics();
const { llm, live: llmLive } = buildLlmClient();

function buildEngine() {
  return createMatchingEngine({
    events: repo,
    metrics,
    llm,
    idempotency: createInMemoryIdempotencyStore(),
  });
}
let engine = buildEngine();

function resetState(): void {
  repo = createInMemoryEventRepository();
  metrics = createInMemoryMetrics();
  engine = buildEngine();
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

/** Turn the JSON wire form into a `RawIntent`, coercing ISO strings to Dates. */
function toIntent(body: Record<string, unknown>): RawIntent {
  const intent: RawIntent = {};
  if (Array.isArray(body['activityIds'])) intent.activityIds = body['activityIds'] as string[];
  if (typeof body['text'] === 'string' && body['text'].trim() !== '') intent.text = body['text'];
  if (Array.isArray(body['locationIds'])) intent.locationIds = body['locationIds'] as string[];
  if (typeof body['startTime'] === 'string') intent.startTime = new Date(body['startTime']);
  if (typeof body['durationMinutes'] === 'number') intent.durationMinutes = body['durationMinutes'];
  if (typeof body['idempotencyKey'] === 'string') intent.idempotencyKey = body['idempotencyKey'];
  return intent;
}

async function readJsonBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 64 * 1024) throw new Error('Request body too large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** Events carry Dates; the wire wants ISO strings. */
function serializeEvent(e: MatchableEvent) {
  return {
    ...e,
    startTime: e.startTime.toISOString(),
    endTime: e.endTime.toISOString(),
    createdAt: e.createdAt.toISOString(),
    expiresAt: e.expiresAt.toISOString(),
  };
}

function metricsPayload() {
  const snap = metrics.snapshot();
  return {
    llmLive,
    llmCalls: snap.counters['llm.calls'] ?? 0,
    matchRequests: snap.counters['match.requests'] ?? 0,
    llmCallRatio: llmCallRatio(snap),
    semanticCacheHitRate: semanticCacheHitRate(snap),
    recommendationCacheHitRate: recommendationCacheHitRate(snap),
    matched: snap.counters['match.matched'] ?? 0,
    pending: snap.counters['match.pending'] ?? 0,
    rejected: snap.counters['match.rejected'] ?? 0,
    eventsCreated: snap.counters['event.created'] ?? 0,
    joinConflicts: snap.counters['match.join_conflict'] ?? 0,
  };
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const send = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    };

    try {
      // --- API -----------------------------------------------------------
      if (path === '/api/vocabulary' && req.method === 'GET') {
        const byCategory = DEFAULT_TAXONOMY.categories.map((c) => ({
          id: c.id,
          name: c.name,
          activities: DEFAULT_TAXONOMY.activities
            .filter((a) => a.categoryId === c.id)
            .map((a) => ({ id: a.id, tags: a.tags })),
        }));
        return send(200, {
          categories: byCategory,
          locations: CMU_LOCATIONS.locations.map((l) => ({ id: l.id, name: l.name })),
          synonyms: Object.keys(DEFAULT_TAXONOMY.synonyms).sort(),
          matchThreshold: engine.config.matchThreshold,
        });
      }

      if (path === '/api/recommend' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const userId = typeof body['userId'] === 'string' ? body['userId'] : undefined;
        const result = await engine.recommend(toIntent(body), userId);
        return send(200, {
          advisory: result.advisory,
          cacheHit: result.cacheHit,
          recommendations: result.recommendations.map((r) => ({
            eventId: r.eventId,
            score: r.score,
            breakdown: r.breakdown,
            event: serializeEvent(r.event),
          })),
          metrics: metricsPayload(),
        });
      }

      if (path === '/api/match' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const userId = typeof body['userId'] === 'string' ? body['userId'] : '';
        if (userId === '') return send(400, { error: 'userId is required' });
        const outcome = await engine.match(userId, toIntent(body));
        return send(200, {
          outcome:
            outcome.status === 'REJECTED'
              ? outcome
              : { ...outcome, event: serializeEvent(outcome.event) },
          metrics: metricsPayload(),
        });
      }

      if (path === '/api/suggestions' && req.method === 'GET') {
        const userId = url.searchParams.get('userId') ?? 'demo-user';
        const suggestions = await engine.suggestActivities(userId);
        return send(200, { suggestions, metrics: metricsPayload() });
      }

      if (path === '/api/events' && req.method === 'GET') {
        return send(200, { events: repo.all().map(serializeEvent) });
      }

      if (path === '/api/metrics' && req.method === 'GET') {
        return send(200, metricsPayload());
      }

      if (path === '/api/reset' && req.method === 'POST') {
        resetState();
        return send(200, { ok: true, metrics: metricsPayload() });
      }

      // --- Static --------------------------------------------------------
      if (req.method === 'GET') {
        const rel = path === '/' ? 'index.html' : path.slice(1);
        // Contain path traversal: resolve, then verify it stayed inside PUBLIC_DIR.
        const target = normalize(join(PUBLIC_DIR, rel));
        if (!target.startsWith(PUBLIC_DIR)) return send(403, { error: 'Forbidden' });
        const ext = target.slice(target.lastIndexOf('.'));
        const file = await readFile(target).catch(() => undefined);
        if (file === undefined) return send(404, { error: 'Not found' });
        res.writeHead(200, { 'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream' });
        return res.end(file);
      }

      return send(404, { error: 'Not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return send(400, { error: message });
    }
  })();
});

server.listen(PORT, () => {
  console.log(`\n  FriendMatch demo → http://localhost:${PORT}`);
  console.log(
    llmLive
      ? '  LLM: live (ANTHROPIC_API_KEY detected)'
      : '  LLM: not configured — deterministic tier only, which is the point\n',
  );
});
