import type { CanonicalLocation, LocationId, LocationService } from '../core/types.js';
import type { LocationConfig } from '../config/types.js';

const EARTH_RADIUS_METERS = 6_371_000;

/**
 * A user resolving from raw device coordinates farther than this from every
 * canonical location is not "at" any of them — e.g. someone across town in
 * Pittsburgh should not silently resolve to the nearest CMU building.
 * Generous on purpose: campus-scale, not building-scale.
 */
const DEFAULT_MAX_RESOLVE_RADIUS_METERS = 5000;

export interface LocationServiceOptions {
  /** Beyond this distance from the nearest canonical location, resolution fails (returns null). */
  maxResolveRadiusMeters?: number;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Great-circle distance between two lat/lon points, in metres, via the
 * haversine formula. Exported standalone so it is unit-testable without
 * constructing a full `LocationService`.
 */
export function haversineMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = toRadians(bLat - aLat);
  const dLon = toRadians(bLon - aLon);
  const lat1 = toRadians(aLat);
  const lat2 = toRadians(bLat);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_METERS * c;
}

function isValidLatLon(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

/**
 * Builds a `LocationService` over a fixed canonical location list. Pure and
 * synchronous — no network calls; "resolving" a coordinate is a local
 * nearest-neighbour scan against `config.locations`, never an external
 * geocoding request.
 */
export function createLocationService(
  config: LocationConfig,
  options?: LocationServiceOptions,
): LocationService {
  const maxResolveRadiusMeters =
    options?.maxResolveRadiusMeters ?? DEFAULT_MAX_RESOLVE_RADIUS_METERS;

  // Precomputed once at construction; every lookup after this is O(1).
  const byId = new Map<LocationId, CanonicalLocation>();
  for (const location of config.locations) {
    byId.set(location.id, location);
  }

  function getLocation(id: LocationId): CanonicalLocation | undefined {
    return byId.get(id);
  }

  function resolveNearestLocation(latitude: number, longitude: number): CanonicalLocation | null {
    if (!isValidLatLon(latitude, longitude)) return null;

    let nearest: CanonicalLocation | null = null;
    let nearestDistance = Infinity;

    for (const location of config.locations) {
      const distance = haversineMeters(latitude, longitude, location.latitude, location.longitude);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = location;
      }
    }

    if (!nearest || nearestDistance > maxResolveRadiusMeters) return null;
    return nearest;
  }

  function distanceMeters(a: LocationId, b: LocationId): number | null {
    const locationA = byId.get(a);
    const locationB = byId.get(b);
    if (!locationA || !locationB) return null;
    return haversineMeters(
      locationA.latitude,
      locationA.longitude,
      locationB.latitude,
      locationB.longitude,
    );
  }

  return { resolveNearestLocation, getLocation, distanceMeters };
}
