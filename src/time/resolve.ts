import type {
  ActivityId,
  AvailabilityService,
  ResolvedTime,
  UserId,
} from '../core/types.js';
import type { AlgorithmConfig } from '../config/types.js';
import { resolveDuration } from './duration.js';
import { parseRelativeTime } from './relative.js';

export interface ResolveTimeArgs {
  explicitStart?: Date;
  explicitEnd?: Date;
  normalizedText?: string;
  activityId?: ActivityId;
  explicitDurationMinutes?: number;
  userId?: UserId;
  availability?: AvailabilityService;
  config: AlgorithmConfig;
  now: Date;
}

/**
 * Resolves the time window for a match/recommendation request. Implements
 * the spec's three cases, tried in order, and always returns a valid
 * `ResolvedTime` — this function must never throw, since a broken time
 * window (or a downstream outage) should degrade the match quality, not the
 * whole request.
 *
 * 1. **Explicit time.** `explicitStart` (with `explicitEnd`, or a duration-
 *    derived end when only a start is given) is used as-is. If the resulting
 *    pair is invalid (`endTime <= startTime`), it is discarded — not
 *    "corrected" — and resolution falls through to case 2. (An
 *    `explicitEnd` given without an `explicitStart` is likewise not treated
 *    as "explicit": there is no start to anchor it to, so this case is
 *    skipped entirely and resolution falls through.)
 * 2. **Relative time.** `parseRelativeTime` on `normalizedText`; the end
 *    time is derived from `resolveDuration`.
 * 3. **No time.** `availability.getNextAvailableSlot` is consulted when both
 *    `availability` and `userId` are supplied. Its slot is used verbatim
 *    (including its own end time) on success. Any of "not configured",
 *    "returned null", or "threw/rejected" is treated identically: fall back
 *    to `now + config.fallbackStartOffsetMinutes` for the resolved duration.
 *    This is the graceful-degradation path — an availability outage must
 *    never fail the match.
 */
export async function resolveTime(args: ResolveTimeArgs): Promise<ResolvedTime> {
  const {
    explicitStart,
    explicitEnd,
    normalizedText,
    activityId,
    explicitDurationMinutes,
    userId,
    availability,
    config,
    now,
  } = args;

  const durationMinutes = resolveDuration(activityId, explicitDurationMinutes, config);

  // Case 1: explicit time.
  if (explicitStart !== undefined) {
    const endTime = explicitEnd ?? new Date(explicitStart.getTime() + durationMinutes * 60_000);
    if (endTime.getTime() > explicitStart.getTime()) {
      return { startTime: explicitStart, endTime, source: 'EXPLICIT' };
    }
    // Invalid pair — fall through rather than propagate a zero/negative window.
  }

  // Case 2: relative time phrase.
  if (normalizedText !== undefined) {
    const relative = parseRelativeTime(normalizedText, now);
    if (relative !== null) {
      const endTime = new Date(relative.startTime.getTime() + durationMinutes * 60_000);
      return { startTime: relative.startTime, endTime, source: 'RELATIVE_TEXT' };
    }
  }

  // Case 3: availability, with a hard fallback.
  if (availability !== undefined && userId !== undefined) {
    try {
      const slot = await availability.getNextAvailableSlot(userId, durationMinutes);
      if (slot !== null) {
        return { startTime: slot.startTime, endTime: slot.endTime, source: 'AVAILABILITY' };
      }
    } catch {
      // Availability outage: degrade to the default fallback below instead
      // of failing the request.
    }
  }

  const startTime = new Date(now.getTime() + config.fallbackStartOffsetMinutes * 60_000);
  const endTime = new Date(startTime.getTime() + durationMinutes * 60_000);
  return { startTime, endTime, source: 'DEFAULT_FALLBACK' };
}
