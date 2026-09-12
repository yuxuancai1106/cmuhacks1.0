import type {
  ActivityId,
  CacheService,
  LlmClient,
  Metrics,
  SemanticInterpretation,
  SemanticParser,
  SemanticParseResult,
  TaxonomyIndex,
} from '../core/types.js';
import type { AlgorithmConfig } from '../config/types.js';
import { normalizeText, tokenize } from '../core/text.js';
import { validateSemanticOutput } from './schema.js';
import { semanticKey } from '../cache/keys.js';

export interface SemanticParserDeps {
  taxonomy: TaxonomyIndex;
  cache: CacheService;
  llm?: LlmClient;
  config: AlgorithmConfig;
  metrics: Metrics;
}

/**
 * Deterministic exact-id-or-synonym lookup for a single (already
 * normalized) piece of text.
 */
function deterministicLookup(normalized: string, taxonomy: TaxonomyIndex): ActivityId | undefined {
  if (taxonomy.hasActivity(normalized)) return normalized;
  return taxonomy.resolveSynonym(normalized);
}

/**
 * Try the deterministic lookup on every token of multi-word text (e.g. "work
 * on my robotics project" -> token "robotics" matches, 0 LLM calls). When
 * more than one token matches, the longest matching token wins: it is
 * treated as the more specific/less ambiguous word. Ties keep the earliest
 * (leftmost) match, since tokens are scanned left-to-right and only a
 * strictly longer token displaces the current winner.
 */
function bestTokenMatch(normalizedText: string, taxonomy: TaxonomyIndex): ActivityId | undefined {
  let winner: { id: ActivityId; tokenLength: number } | undefined;
  for (const token of tokenize(normalizedText)) {
    const match = deterministicLookup(token, taxonomy);
    if (match === undefined) continue;
    if (winner === undefined || token.length > winner.tokenLength) {
      winner = { id: match, tokenLength: token.length };
    }
  }
  return winner?.id;
}

/**
 * Build a full interpretation from a resolved activity id. Returns
 * undefined if the taxonomy reports the id as known but has no category for
 * it -- an internal inconsistency in the injected `TaxonomyIndex` that this
 * parser treats as "no match" rather than fabricating a broken result.
 */
function resolveDeterministic(activityId: ActivityId, taxonomy: TaxonomyIndex): SemanticInterpretation | undefined {
  const category = taxonomy.categoryOf(activityId);
  if (category === undefined) return undefined;
  return {
    canonicalActivity: activityId,
    category,
    tags: taxonomy.tagsFor(activityId),
    confidence: 1.0,
  };
}

/** True for a signal/error pair that indicates the request was aborted (timeout or caller cancellation). */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * Implements the spec's decision sequence in order: normalize -> exact/
 * synonym match on the whole text -> exact/synonym match per token ->
 * semantic cache -> LLM. Never throws; any LLM-stage failure degrades to a
 * `FALLBACK` result so the caller can fall back to structured activity ids.
 */
export function createSemanticParser(deps: SemanticParserDeps): SemanticParser {
  const { taxonomy, cache, llm, config, metrics } = deps;

  async function parse(text: string, signal?: AbortSignal): Promise<SemanticParseResult> {
    const normalized = normalizeText(text);
    if (normalized.length === 0) {
      return { interpretation: null, source: 'DETERMINISTIC' };
    }

    // Deterministic: whole normalized text as an id/synonym, then per-token.
    // No cache read and no LLM call happen on this path.
    const wholeTextId = deterministicLookup(normalized, taxonomy);
    const tokenId = wholeTextId === undefined ? bestTokenMatch(normalized, taxonomy) : undefined;
    const deterministicId = wholeTextId ?? tokenId;
    if (deterministicId !== undefined) {
      const interpretation = resolveDeterministic(deterministicId, taxonomy);
      if (interpretation !== undefined) {
        metrics.increment('semantic.deterministic.hit');
        return { interpretation, source: 'DETERMINISTIC' };
      }
    }

    // Semantic cache -- must be checked before any LLM call.
    // Use the shared key builder rather than interpolating inline: it bounds
    // key length (long free-text phrases would otherwise be embedded verbatim
    // and could exceed a real backend's key limit, silently failing to cache
    // and turning every repeat into a fresh LLM call).
    //
    // Note what this does NOT do: a phrase at or under `semanticKey`'s 64-char
    // bound is embedded in the key verbatim. That is the spec's pinned
    // `semantic:{normalizedText}` format, and it is unavoidable for a key that
    // must recognize a repeat of the same phrase. It is harmless for the
    // in-process default cache; a shared backend (Redis) means the phrases
    // users type live in that keyspace, so give the engine its own
    // database/prefix and retention policy. See README > Privacy.
    const cacheKey = semanticKey(normalized);
    let cached: SemanticInterpretation | undefined;
    try {
      cached = await cache.get<SemanticInterpretation>(cacheKey);
    } catch {
      // A flaky cache backend degrades to a miss, not a thrown error.
      cached = undefined;
    }
    if (cached !== undefined) {
      metrics.increment('semantic.cache.hit');
      return { interpretation: cached, source: 'CACHE' };
    }
    metrics.increment('semantic.cache.miss');

    if (!llm) {
      // Not configured is not itself an "error" -- no call was attempted,
      // so `llm.errors`/`llm.calls` are intentionally left untouched.
      return { interpretation: null, source: 'FALLBACK', degradedReason: 'LLM_NOT_CONFIGURED' };
    }

    metrics.increment('llm.calls');
    const startedAt = Date.now();
    let raw: unknown;
    try {
      raw = await llm.extractSemantics(normalized, signal);
    } catch (err) {
      metrics.increment('llm.errors');
      const reason = isAbortError(err) ? 'LLM_TIMEOUT' : 'LLM_CALL_FAILED';
      return { interpretation: null, source: 'FALLBACK', degradedReason: reason };
    } finally {
      metrics.observe('llm.latency_ms', Date.now() - startedAt);
    }

    const validated = validateSemanticOutput(raw, taxonomy);
    if (validated === null) {
      metrics.increment('llm.errors');
      return { interpretation: null, source: 'FALLBACK', degradedReason: 'LLM_OUTPUT_INVALID' };
    }
    if (validated.confidence < config.minSemanticConfidence) {
      metrics.increment('llm.errors');
      return { interpretation: null, source: 'FALLBACK', degradedReason: 'LLM_LOW_CONFIDENCE' };
    }

    try {
      await cache.set(cacheKey, validated, config.cache.semanticMs);
    } catch {
      // Best-effort cache write: a cache failure must not turn a good LLM
      // result into a thrown error or a FALLBACK.
    }
    return { interpretation: validated, source: 'LLM' };
  }

  return { parse };
}
