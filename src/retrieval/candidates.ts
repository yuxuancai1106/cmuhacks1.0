import type { CandidateQuery, NormalizedIntent, TaxonomyIndex, UserId } from '../core/types.js';
import type { AlgorithmConfig } from '../config/types.js';

/** Dedupe while preserving first-seen order, so output stays deterministic. */
function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Builds the bounded, indexed stage-1 query. Pure and synchronous — this
 * function never touches the database; the repository executes the query it
 * returns. Never omit `limit`: the spec forbids comparing an intent against
 * every event in the store.
 */
export function buildCandidateQuery(args: {
  intent: NormalizedIntent;
  taxonomy: TaxonomyIndex;
  config: AlgorithmConfig;
  now: Date;
  excludeUserId?: UserId;
}): CandidateQuery {
  const { intent, taxonomy, config, now, excludeUserId } = args;

  // Widen the requested activities to siblings/parents/children/related so a
  // near-miss activity is still retrievable; union with any explicit category
  // selections the intent already carries.
  const expanded = taxonomy.expand(intent.activityIds);
  const activityIds = dedupe(expanded.activityIds);
  const categoryIds = dedupe([...expanded.categoryIds, ...intent.categoryIds]);

  // Centre the retrieval window on the requested start time (padded on both
  // sides so an event that merely overlaps, rather than starting exactly on
  // time, is still retrievable); fall back to "now forward" when the intent
  // carries no explicit time.
  const padMs = config.retrievalWindowMinutes * 60_000;
  const windowStart = intent.startTime
    ? new Date(intent.startTime.getTime() - padMs)
    : now;
  const windowEnd = intent.startTime
    ? new Date(intent.startTime.getTime() + padMs)
    : new Date(now.getTime() + padMs);

  return {
    activityIds,
    categoryIds,
    locationIds: [...intent.locationIds],
    windowStart,
    windowEnd,
    now,
    limit: config.candidateLimit,
    excludeUserId,
  };
}
