import type {
  EventId,
  LocationService,
  MatchableEvent,
  NormalizedIntent,
  RejectionReason,
  TaxonomyIndex,
  UserId,
} from '../core/types.js';
import type { AlgorithmConfig } from '../config/types.js';
import { locationCompatibility } from '../scoring/location.js';
import { timeScore } from '../scoring/time.js';

export interface HardFilterDeps {
  taxonomy: TaxonomyIndex;
  locations: LocationService;
  config: AlgorithmConfig;
}

/**
 * Cheap, deterministic eliminations run before detailed scoring/ranking.
 *
 * This is defence in depth, not the primary filter: `EventRepository.findCandidates`
 * already pushes status / expiry / capacity filtering into the database query
 * (see `CandidateQuery`). We re-check those same conditions here anyway
 * because retrieved rows can be stale by the time they reach this stage — the
 * cache may have served a slightly old recommendation, or another request may
 * have raced ahead and filled/closed the event between retrieval and now.
 * Checks are ordered cheapest-first and short-circuit per event so we never
 * pay for taxonomy/time/location scoring on an event that a field comparison
 * already ruled out.
 */
export function hardFilter(args: {
  intent: NormalizedIntent;
  events: MatchableEvent[];
  deps: HardFilterDeps;
  now: Date;
  userId?: UserId;
}): { kept: MatchableEvent[]; rejected: Array<{ eventId: EventId; reason: RejectionReason }> } {
  const { intent, events, deps, now, userId } = args;
  const kept: MatchableEvent[] = [];
  const rejected: Array<{ eventId: EventId; reason: RejectionReason }> = [];

  for (const event of events) {
    const reason = firstRejectionReason(intent, event, deps, now, userId);
    if (reason) {
      rejected.push({ eventId: event.id, reason });
    } else {
      kept.push(event);
    }
  }

  return { kept, rejected };
}

function firstRejectionReason(
  intent: NormalizedIntent,
  event: MatchableEvent,
  deps: HardFilterDeps,
  now: Date,
  userId: UserId | undefined,
): RejectionReason | undefined {
  if (event.status !== 'OPEN') return 'NOT_OPEN';
  if (event.expiresAt <= now) return 'EXPIRED';
  if (event.participantCount >= event.capacity) return 'FULL';

  if (userId !== undefined) {
    if (event.participantIds?.includes(userId)) return 'ALREADY_PARTICIPANT';
    if (event.creatorId === userId) return 'OWN_EVENT';
  }

  // Cheap window check before the weighted time score: an event that ends in
  // the past can be rejected without touching the scoring config at all.
  if (event.endTime <= now) return 'TIME_INCOMPATIBLE';
  const time = timeScore(intent, event, deps.config, now);
  if (time < deps.config.time.minAcceptable) return 'TIME_INCOMPATIBLE';

  const location = locationCompatibility(
    intent.locationIds,
    event.locationId,
    deps.locations,
    deps.config,
  );
  if (location < deps.config.location.minAcceptable) return 'LOCATION_INCOMPATIBLE';

  // Only meaningful when the intent actually named activities — an intent
  // that arrived via category/tag alone has nothing to compare similarity
  // against, so it cannot be activity-incompatible.
  if (intent.activityIds.length > 0) {
    let bestSimilarity = 0;
    for (const activityId of intent.activityIds) {
      const similarity = deps.taxonomy.similarity(activityId, event.activityId);
      if (similarity > bestSimilarity) bestSimilarity = similarity;
    }
    if (bestSimilarity === 0) return 'ACTIVITY_INCOMPATIBLE';
  }

  return undefined;
}
