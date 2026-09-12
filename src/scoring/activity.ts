import type { MatchableEvent, NormalizedIntent, TaxonomyIndex } from '../core/types.js';
import type { AlgorithmConfig } from '../config/types.js';

/**
 * Best (max) similarity between any intent activity and the event's
 * activity, via the taxonomy's deterministic `similarity`.
 *
 * When the intent carries no activities but does carry categories, we fall
 * back to a category-level score. The brief's literal example for this
 * fallback is "1.0 if event.categoryId is among intent.categoryIds, else
 * 0", but it also directs us to prefer a configured value over a hardcoded
 * number wherever one already exists. `activitySimilarity.sameCategory` is
 * exactly that value (it already encodes "these are only related by
 * category, not activity"), and reusing it here keeps a category-only
 * intent from scoring as if it were as precise as an exact activity match.
 * Resolved ambiguity: fallback match -> `config.activitySimilarity.sameCategory`
 * (not a hardcoded 1.0); no match -> 0.
 *
 * No intent activities and no categories -> 0 (nothing to compare against).
 */
export function activityScore(
  intent: NormalizedIntent,
  event: MatchableEvent,
  taxonomy: TaxonomyIndex,
  config: AlgorithmConfig,
): number {
  if (intent.activityIds.length > 0) {
    let best = 0;
    for (const activityId of intent.activityIds) {
      const similarity = taxonomy.similarity(activityId, event.activityId);
      if (similarity > best) best = similarity;
    }
    return best;
  }

  if (intent.categoryIds.length > 0) {
    return intent.categoryIds.includes(event.categoryId)
      ? config.activitySimilarity.sameCategory
      : 0;
  }

  return 0;
}
