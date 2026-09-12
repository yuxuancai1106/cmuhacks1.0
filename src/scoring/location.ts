import type { AlgorithmConfig } from '../config/types.js';
import type { LocationId, LocationService } from '../core/types.js';

/**
 * Scores how well a candidate event's location matches the locations named
 * in an intent. Pure and synchronous: no I/O, no LLM.
 *
 * Returns `1` when `intentLocationIds` is empty — no location constraint
 * means no penalty, not "everything is far away". Another lane's scorer
 * depends on exactly this signature and this semantic; do not change it.
 *
 * When multiple locations are selected, the event only needs to be
 * acceptable near *one* of them, so the result is the best (max)
 * per-location compatibility, per the spec.
 */
export function locationCompatibility(
  intentLocationIds: LocationId[],
  eventLocationId: LocationId,
  locations: LocationService,
  config: AlgorithmConfig,
): number {
  if (intentLocationIds.length === 0) return 1;

  let best = config.location.far;
  for (const intentLocationId of intentLocationIds) {
    const score = pairCompatibility(intentLocationId, eventLocationId, locations, config);
    if (score > best) best = score;
  }
  return best;
}

function pairCompatibility(
  intentLocationId: LocationId,
  eventLocationId: LocationId,
  locations: LocationService,
  config: AlgorithmConfig,
): number {
  // Identical ids are "the same location" even if the id happens to be
  // unrecognized by the location service (e.g. a custom/off-catalog id both
  // sides agree on) — there is nothing more "same" than an exact id match,
  // so this check comes before any lookup that could fail on unknown ids.
  if (intentLocationId === eventLocationId) return 1.0;

  const distance = locations.distanceMeters(intentLocationId, eventLocationId);
  // Unknown location id on either side (or a service that can't relate them):
  // never throw, degrade to the worst-case band instead.
  if (distance === null) return config.location.far;

  // Ascending by maxMeters so the first matching band is the tightest one,
  // regardless of the order a caller's config happens to list them in.
  const bands = [...config.location.bands].sort((a, b) => a.maxMeters - b.maxMeters);
  for (const band of bands) {
    if (distance <= band.maxMeters) return band.score;
  }

  const intentLocation = locations.getLocation(intentLocationId);
  const eventLocation = locations.getLocation(eventLocationId);
  if (intentLocation && eventLocation && intentLocation.campusId === eventLocation.campusId) {
    return config.location.sameCampus;
  }

  return config.location.far;
}
