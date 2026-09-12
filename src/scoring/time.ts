import type { MatchableEvent, NormalizedIntent } from '../core/types.js';
import type { AlgorithmConfig } from '../config/types.js';

const MS_PER_MINUTE = 60_000;

/**
 * Overlap between two closed time intervals, in minutes. Never negative —
 * non-overlapping intervals yield 0. Pure arithmetic with no dependency on
 * `now`, so hard filters can reuse it alongside the scorer.
 */
export function timeOverlapMinutes(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): number {
  const overlapStartMs = Math.max(aStart.getTime(), bStart.getTime());
  const overlapEndMs = Math.min(aEnd.getTime(), bEnd.getTime());
  const overlapMs = overlapEndMs - overlapStartMs;
  return overlapMs > 0 ? overlapMs / MS_PER_MINUTE : 0;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Linear decay from 1.0 at `perfectToleranceMinutes` to 0.0 at
 * `maxToleranceMinutes`. Linear is the simplest monotonic curve that
 * satisfies the two anchor points the config gives us; the spec calls for
 * "smooth monotonic decay" but does not prescribe a shape, and a straight
 * line needs no extra tuning knobs beyond the two the config already has.
 */
function startProximity(deltaMinutes: number, perfectToleranceMinutes: number, maxToleranceMinutes: number): number {
  if (deltaMinutes <= perfectToleranceMinutes) return 1;
  if (deltaMinutes >= maxToleranceMinutes) return 0;
  const span = maxToleranceMinutes - perfectToleranceMinutes;
  if (span <= 0) return 0; // misconfigured tolerances (max <= perfect): no partial-credit band
  return 1 - (deltaMinutes - perfectToleranceMinutes) / span;
}

/**
 * Time compatibility blends two signals, per the spec's insistence that
 * interval activities need real overlap and not just a start-timestamp
 * comparison:
 *
 * - `startProximity`: how close the requested and event start times are.
 * - `overlapRatio`: `overlapMinutes / min(intentDuration, eventDuration)`,
 *   so a short intent fully contained in a longer event (or vice versa)
 *   still reads as full-strength overlap rather than being penalized for
 *   the durations differing.
 *
 * Special cases (documented per the brief):
 * - No `intent.startTime` at all: the user gave no time signal, so we
 *   return a neutral 0.5 — unknown, not incompatible — rather than scoring
 *   it as a mismatch.
 * - An event whose `endTime` is already at or before `now`: dead regardless
 *   of how well it would otherwise line up, so it scores 0.
 * - No `intent.endTime`: we can't compute the intent's own duration, so
 *   (per the brief) we treat its duration as the event's duration for the
 *   ratio. Concretely, that means the ratio's denominator becomes the
 *   event's duration, and we compute overlap against an intent interval
 *   that starts at `intent.startTime` and runs for the event's duration.
 */
export function timeScore(
  intent: NormalizedIntent,
  event: MatchableEvent,
  config: AlgorithmConfig,
  now: Date,
): number {
  if (!intent.startTime) return 0.5;
  if (event.endTime.getTime() <= now.getTime()) return 0;

  const { perfectToleranceMinutes, maxToleranceMinutes, overlapWeight } = config.time;

  const deltaMinutes =
    Math.abs(event.startTime.getTime() - intent.startTime.getTime()) / MS_PER_MINUTE;
  const proximity = startProximity(deltaMinutes, perfectToleranceMinutes, maxToleranceMinutes);

  const eventDurationMinutes = (event.endTime.getTime() - event.startTime.getTime()) / MS_PER_MINUTE;
  const intentEnd =
    intent.endTime ?? new Date(intent.startTime.getTime() + eventDurationMinutes * MS_PER_MINUTE);
  const intentDurationMinutes = intent.endTime
    ? (intent.endTime.getTime() - intent.startTime.getTime()) / MS_PER_MINUTE
    : eventDurationMinutes;

  const overlapMinutes = timeOverlapMinutes(intent.startTime, intentEnd, event.startTime, event.endTime);
  const denominatorMinutes = Math.min(intentDurationMinutes, eventDurationMinutes);
  const overlapRatio = denominatorMinutes > 0 ? clamp01(overlapMinutes / denominatorMinutes) : 0;

  return (1 - overlapWeight) * proximity + overlapWeight * overlapRatio;
}
