import type { ActivityId } from '../core/types.js';
import type { AlgorithmConfig } from '../config/types.js';

/**
 * Hard ceiling on any resolved duration, regardless of source. A friend
 * hangout that claims to run longer than a working day is almost certainly a
 * bad input (typo, unit confusion) rather than a real intent, so it's capped
 * rather than trusted verbatim.
 */
export const MAX_DURATION_MINUTES = 8 * 60;

/**
 * Resolves how long an activity should run, in minutes, by precedence:
 * 1. An explicit user-supplied duration, if it's a valid positive number
 *    (capped at `MAX_DURATION_MINUTES`). An invalid explicit value (NaN,
 *    zero, negative, non-finite) is treated as absent rather than an error —
 *    it falls through to the next source.
 * 2. The configured default duration for `activityId`, if known.
 * 3. `config.defaultDurationMinutes`.
 *
 * Pure and synchronous; never throws.
 */
export function resolveDuration(
  activityId: ActivityId | undefined,
  explicitMinutes: number | undefined,
  config: AlgorithmConfig,
): number {
  if (
    explicitMinutes !== undefined &&
    Number.isFinite(explicitMinutes) &&
    explicitMinutes > 0
  ) {
    return Math.min(explicitMinutes, MAX_DURATION_MINUTES);
  }

  if (activityId !== undefined) {
    const configured = config.activityDurationsMinutes[activityId];
    if (configured !== undefined) return configured;
  }

  return config.defaultDurationMinutes;
}
