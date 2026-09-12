import type { MatchableEvent } from '../core/types.js';

const MS_PER_HOUR = 3_600_000;

/**
 * A 24h horizon for the freshness signal below. Chosen because it
 * comfortably spans this engine's default event TTL (2h, see
 * `defaultEventTtlMinutes`) and typical retrieval windows, so almost every
 * live event falls inside it and gets a graded score rather than clipping
 * to the same extreme. Quality is only 5% of the final score, so this is a
 * fixed constant rather than a config knob — not worth a tuning surface.
 */
const FRESHNESS_WINDOW_MS = 24 * MS_PER_HOUR;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Triangular curve peaking at 50% filled: an empty event has no social
 * proof yet, an (almost) full event has no room left to actually join, and
 * both read as lower quality than one with "some traction, still has
 * room". Capacity <= 0 is treated as unusable (0) rather than dividing by
 * zero.
 */
function fillRatioScore(event: MatchableEvent): number {
  if (event.capacity <= 0) return 0;
  const fill = clamp01(event.participantCount / event.capacity);
  return 1 - Math.abs(fill - 0.5) * 2;
}

/**
 * Rewards events created recently (linear decay to 0 over
 * `FRESHNESS_WINDOW_MS`) and events with more runway left before
 * `expiresAt` (same decay). Averaging the two means an old-but-long-lived
 * event and a new-but-about-to-expire event land in similar territory
 * rather than either signal dominating alone.
 */
function freshnessScore(event: MatchableEvent, now: Date): number {
  const ageMs = now.getTime() - event.createdAt.getTime();
  const recency = clamp01(1 - ageMs / FRESHNESS_WINDOW_MS);

  const remainingMs = event.expiresAt.getTime() - now.getTime();
  const timeLeft = clamp01(remainingMs / FRESHNESS_WINDOW_MS);

  return (recency + timeLeft) / 2;
}

/**
 * Event quality is a minor (5%) tiebreaker: equal parts fill ratio (some
 * traction, not full) and freshness (new enough, not about to expire).
 * Deterministic, no I/O; `now` is always caller-supplied.
 */
export function qualityScore(event: MatchableEvent, now: Date): number {
  return clamp01(0.5 * fillRatioScore(event) + 0.5 * freshnessScore(event, now));
}
