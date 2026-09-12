/**
 * Weighted-overlap tag similarity in [0, 1], order-insensitive. Inputs are
 * assumed already normalized/lowercased; we only de-duplicate here.
 *
 * Plain Jaccard (|intersection| / |union|) treats the intent's tags and the
 * event's tags symmetrically, so an event that fully covers the user's
 * tags but also carries a couple of unrelated ones gets penalized as if
 * those extra tags were a downside worth weighing equally against the
 * match. The spec's own example — intent [treadmill, cardio, running] vs.
 * event [treadmill, workout, cardio] — is exactly this case: 2 of 4 distinct
 * tags shared gives a plain Jaccard of 0.5, which reads as mediocre despite
 * the event satisfying two-thirds of what the user actually asked for.
 *
 * We blend plain Jaccard with intent-coverage (|intersection| / |intentTags|),
 * weighted evenly:
 *   score = 0.5 * jaccard + 0.5 * coverage
 * Jaccard keeps some penalty for an event whose tags mostly miss the
 * intent's; coverage rewards the event in proportion to how much of the
 * *intent's* tag list it satisfies, since satisfying the user's stated
 * interest matters more than the event carrying a couple of extra tags.
 * Both terms are O(n) set operations, deterministic and cheap.
 */
export function tagScore(intentTags: string[], eventTags: string[]): number {
  if (intentTags.length === 0 || eventTags.length === 0) return 0;

  const intentSet = new Set(intentTags);
  const eventSet = new Set(eventTags);

  let intersectionSize = 0;
  for (const tag of intentSet) {
    if (eventSet.has(tag)) intersectionSize++;
  }
  if (intersectionSize === 0) return 0;

  const unionSize = intentSet.size + eventSet.size - intersectionSize;
  const jaccard = intersectionSize / unionSize;
  const coverage = intersectionSize / intentSet.size;

  return 0.5 * jaccard + 0.5 * coverage;
}
