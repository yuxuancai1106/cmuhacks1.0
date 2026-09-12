import type { LlmClient, TaxonomyIndex } from '../core/types.js';
import { SEMANTIC_OUTPUT_JSON_SCHEMA } from '../semantic/schema.js';

/**
 * Minimal fetch signature so callers can inject a mock, an instrumented
 * client, or a non-global fetch implementation without this package taking
 * a runtime dependency on `@anthropic-ai/sdk` (or on any HTTP library).
 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface AnthropicLlmClientOptions {
  /** Used to tell the model the exact controlled vocabulary it may choose from. */
  taxonomy: TaxonomyIndex;
  /** Defaults to `process.env.ANTHROPIC_API_KEY`. */
  apiKey?: string;
  /** Fast, cheap model id -- this is a short extraction call on a latency-critical path. */
  model?: string;
  /** Defaults to the public Anthropic Messages API endpoint. */
  baseUrl?: string;
  /** Request timeout in ms, enforced via AbortSignal. */
  timeoutMs?: number;
  /** Injectable fetch implementation (tests, custom networking stacks). Defaults to global `fetch`. */
  fetchImpl?: FetchLike;
}

/**
 * `claude-haiku-4-5-20251001`: the fastest, cheapest current-generation model. This
 * call extracts a handful of fields from a short user phrase on a
 * latency-critical path, which is exactly the workload that model tier is
 * for -- a larger/slower model would add cost and latency with no
 * meaningful quality gain for this task.
 */
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_TIMEOUT_MS = 2500;
const ANTHROPIC_VERSION = '2023-06-01';
const TOOL_NAME = 'extract_semantics';

interface AnthropicToolUseBlock {
  type: 'tool_use';
  input?: unknown;
}

interface AnthropicMessagesResponse {
  content?: Array<{ type: string; input?: unknown }>;
}

function isToolUseBlock(block: { type: string; input?: unknown }): block is AnthropicToolUseBlock {
  return block.type === 'tool_use';
}

function buildSystemPrompt(activityIds: string[], categoryIds: string[]): string {
  return [
    'You extract structured activity semantics from a short phrase a user typed when looking for a friend to do an activity with.',
    `Choose canonicalActivity from this exact list only: ${activityIds.join(', ')}.`,
    `Choose category from this exact list only: ${categoryIds.join(', ')}.`,
    'Return 1 to 12 short lowercase descriptive tags.',
    'Return confidence in [0, 1] reflecting how well canonicalActivity matches the input phrase.',
    'Call the provided tool with your answer. No explanations. JSON only.',
  ].join(' ');
}

/**
 * `fetch`-based Anthropic Messages API client. Deliberately dependency-free
 * (no `@anthropic-ai/sdk`): accepts an injectable `fetchImpl` so the caller
 * can swap in a mock or a custom HTTP stack. Requests structured output via
 * a forced tool call against `SEMANTIC_OUTPUT_JSON_SCHEMA`. Never logs the
 * input text, and sends it nowhere but this one API call.
 */
export function createAnthropicLlmClient(opts: AnthropicLlmClientOptions): LlmClient {
  const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'];
  const model = opts.model ?? DEFAULT_MODEL;
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl: FetchLike = opts.fetchImpl ?? fetch;

  const activityIds = opts.taxonomy.allActivityIds();
  const categoryIds = [
    ...new Set(
      activityIds
        .map((id) => opts.taxonomy.categoryOf(id))
        .filter((id): id is string => id !== undefined),
    ),
  ];
  const systemPrompt = buildSystemPrompt(activityIds, categoryIds);

  return {
    async extractSemantics(text: string, signal?: AbortSignal): Promise<unknown> {
      if (apiKey === undefined || apiKey.length === 0) {
        throw new Error('ANTHROPIC_API_KEY is not configured');
      }

      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
      const onExternalAbort = (): void => timeoutController.abort();
      signal?.addEventListener('abort', onExternalAbort);

      try {
        const response = await fetchImpl(baseUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify({
            model,
            max_tokens: 256,
            system: systemPrompt,
            messages: [{ role: 'user', content: text }],
            tools: [
              {
                name: TOOL_NAME,
                description:
                  'Record the canonical activity, category, tags, and confidence extracted from the input phrase.',
                input_schema: SEMANTIC_OUTPUT_JSON_SCHEMA,
              },
            ],
            tool_choice: { type: 'tool', name: TOOL_NAME },
          }),
          signal: timeoutController.signal,
        });

        if (!response.ok) {
          throw new Error(`Anthropic API request failed with status ${response.status}`);
        }

        const body = (await response.json()) as AnthropicMessagesResponse;
        const toolUse = (body.content ?? []).find(isToolUseBlock);
        if (toolUse === undefined || toolUse.input === undefined) {
          throw new Error('Anthropic API response did not contain a tool_use block');
        }
        return toolUse.input;
      } finally {
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onExternalAbort);
      }
    },
  };
}

/** Always fails. Used to prove graceful degradation (FALLBACK) when no LLM is configured. */
export function createNullLlmClient(): LlmClient {
  return {
    extractSemantics(): Promise<unknown> {
      return Promise.reject(new Error('LLM_NOT_CONFIGURED'));
    },
  };
}
