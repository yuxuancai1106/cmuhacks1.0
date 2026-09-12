import { describe, it, expect } from 'vitest';
import { createLocationService, haversineMeters } from '../../src/location/service.js';
import { CMU_LOCATIONS } from '../../src/config/locations.js';
import { makeLocationService, TEST_LOCATION_CONFIG } from '../../tests/support/factories.js';

const locations = makeLocationService();

describe('getLocation', () => {
  it('returns the canonical location for a known id', () => {
    expect(locations.getLocation('loc-a')).toEqual(TEST_LOCATION_CONFIG.locations[0]);
  });

  it('returns undefined for an unknown id', () => {
    expect(locations.getLocation('loc-unknown')).toBeUndefined();
  });
});

describe('distanceMeters', () => {
  it('returns 0 for a location and itself', () => {
    expect(locations.distanceMeters('loc-a', 'loc-a')).toBe(0);
  });

  it('returns null when either id is unknown', () => {
    expect(locations.distanceMeters('loc-unknown', 'loc-a')).toBeNull();
    expect(locations.distanceMeters('loc-a', 'loc-unknown')).toBeNull();
  });

  it('returns a plausible positive distance between two distinct known locations', () => {
    const distance = locations.distanceMeters('loc-a', 'loc-c');
    expect(distance).not.toBeNull();
    expect(distance ?? -1).toBeGreaterThan(400);
    expect(distance ?? -1).toBeLessThan(600);
  });
});

describe('resolveNearestLocation', () => {
  it('resolves coordinates at a known location to that location', () => {
    const resolved = locations.resolveNearestLocation(40.4425, -79.9425);
    expect(resolved?.id).toBe('loc-a');
  });

  it('resolves coordinates near (but not exactly at) a known location to that location', () => {
    const resolved = locations.resolveNearestLocation(40.44251, -79.94251);
    expect(resolved?.id).toBe('loc-a');
  });

  it('returns null when nothing is within the resolve radius', () => {
    expect(locations.resolveNearestLocation(0, 0)).toBeNull();
  });

  it('returns null for invalid coordinates rather than throwing', () => {
    expect(() => locations.resolveNearestLocation(200, -79.9425)).not.toThrow();
    expect(locations.resolveNearestLocation(200, -79.9425)).toBeNull();
    expect(locations.resolveNearestLocation(40.4425, 200)).toBeNull();
  });

  it('honors a custom maxResolveRadiusMeters option', () => {
    const tight = createLocationService(TEST_LOCATION_CONFIG, { maxResolveRadiusMeters: 10 });
    // loc-b is ~33m from loc-a's coordinates -- outside a 10m radius.
    expect(tight.resolveNearestLocation(40.4425, -79.9425)?.id).toBe('loc-a');
    expect(tight.resolveNearestLocation(40.4428, -79.9425)).not.toBeNull();
  });
});

describe('haversineMeters', () => {
  it('returns 0 for identical coordinates', () => {
    expect(haversineMeters(40.4425, -79.9425, 40.4425, -79.9425)).toBe(0);
  });

  it('returns a plausible distance for a known CMU building pair', () => {
    const cohon = CMU_LOCATIONS.locations.find((l) => l.id === 'cohon-university-center');
    const gates = CMU_LOCATIONS.locations.find((l) => l.id === 'gates-hillman');
    expect(cohon).toBeDefined();
    expect(gates).toBeDefined();
    if (!cohon || !gates) return;

    const distance = haversineMeters(cohon.latitude, cohon.longitude, gates.latitude, gates.longitude);
    // Two on-campus buildings: comfortably more than a few metres, well
    // under a couple of kilometres.
    expect(distance).toBeGreaterThan(10);
    expect(distance).toBeLessThan(2000);
  });
});
