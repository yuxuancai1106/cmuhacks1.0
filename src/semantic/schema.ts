import type { ActivityId, CategoryId, SemanticInterpretation, TaxonomyIndex } from '../core/types.js';
import { normalizeText } from '../core/text.js';

/** Tags beyond this count are dropped, longest-first-kept order (i.e. first N survive). */
const MAX_TAGS = 12;

/**
 * Plain JSON-Schema description of the LLM's expected structured output.
 * Handed to the Anthropic adapter to request structured output via a tool
 * schema (see `src/adapters/anthropicLlmClient.ts`).
 */
export const SEMANTIC_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    canonicalActivity: {
      type: 'string',
      description: 'Best-matching controlled-vocabulary activity id for the input phrase.',
    },
    category: {
      type: 'string',
      description: 'Controlled-vocabulary category id that canonicalActivity belongs to.',
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      maxItems: MAX_TAGS,
      description: 'Up to 12 short, lowercase descriptive tags for the activity.',
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Confidence in [0, 1] that canonicalActivity correctly captures the input phrase.',
    },
  },
  required: ['canonicalActivity', 'category', 'tags', 'confidence'],
  additionalProperties: false,
} as const;

/**
 * Hand-written validator for the LLM's structured output. Returns `null`
 * (never throws) for any malformed shape, and maps free-form model output
 * onto the controlled vocabulary rather than trusting the model's ids
 * directly -- per spec, free text must land in the controlled vocabulary or
 * be rejected outright.
 */
export function validateSemanticOutput(raw: unknown, taxonomy: TaxonomyIndex): SemanticInterpretation | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const record = raw as Record<string, unknown>;
  const { canonicalActivity, category, tags, confidence } = record;

  if (typeof canonicalActivity !== 'string' || canonicalActivity.trim().length === 0) return null;
  if (typeof category !== 'string') return null;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return null;
  }
  if (!Array.isArray(tags) || !tags.every((tag): tag is string => typeof tag === 'string')) return null;

  const normalizedTags = tags
    .map((tag) => normalizeText(tag))
    .filter((tag) => tag.length > 0)
    .slice(0, MAX_TAGS);

  const resolvedActivity = resolveKnownActivity(normalizeText(canonicalActivity), normalizedTags, taxonomy);
  if (resolvedActivity === undefined) return null;

  // Trust the taxonomy's category for the resolved activity over whatever
  // the model claimed -- category is derived data, not a separate model
  // decision, so a disagreement means the model is wrong, not the taxonomy.
  const resolvedCategory: CategoryId | undefined = taxonomy.categoryOf(resolvedActivity);
  if (resolvedCategory === undefined) return null; // defensive: hasActivity(resolvedActivity) is true, so this should be unreachable

  return {
    canonicalActivity: resolvedActivity,
    category: resolvedCategory,
    tags: normalizedTags,
    confidence,
  };
}

/**
 * Map a (normalized) model-supplied activity string onto the controlled
 * vocabulary: exact id, then synonym, then fall back to scanning the
 * model's own tags for something resolvable. Returns undefined when nothing
 * maps -- the caller must then reject the whole interpretation rather than
 * inventing a category.
 */
function resolveKnownActivity(
  normalizedActivity: string,
  normalizedTags: string[],
  taxonomy: TaxonomyIndex,
): ActivityId | undefined {
  if (taxonomy.hasActivity(normalizedActivity)) return normalizedActivity;

  const bySynonym = taxonomy.resolveSynonym(normalizedActivity);
  if (bySynonym !== undefined) return bySynonym;

  for (const tag of normalizedTags) {
    if (taxonomy.hasActivity(tag)) return tag;
    const tagSynonym = taxonomy.resolveSynonym(tag);
    if (tagSynonym !== undefined) return tagSynonym;
  }

  return undefined;
}
