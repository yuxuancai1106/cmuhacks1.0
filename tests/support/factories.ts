/**
 * Shared, typed test builders for the unit + integration suites.
 *
 * Deliberately dependency-free beyond `src/*`: no test framework imports
 * here, so this file can be imported from any test file (unit or
 * integration) without pulling in vitest globals.
 */
import type {
  CanonicalLocation,
  LocationService,
  MatchableEvent,
  NormalizedIntent,
  TaxonomyIndex,
} from '../../src/core/types.js';
import type { AlgorithmConfig, LocationConfig } from '../../src/config/types.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { DEFAULT_TAXONOMY } from '../../src/config/taxonomy.js';
import { buildTaxonomyIndex } from '../../src/core/taxonomyIndex.js';
import { createLocationService } from '../../src/location/service.js';

/** Fixed instant every test anchors to. Never call `Date.now()` / `new Date()` bare in a test. */
export const NOW: Date = new Date('2026-09-12T12:00:00.000Z');

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

/**
 * Builds a real `TaxonomyIndex` over the production `DEFAULT_TAXONOMY`
 * (see `src/config/taxonomy.ts`) rather than a hand-rolled fixture: the
 * spec's worked examples (treadmill/workout/running/basketball/painting)
 * are literally the ids in that controlled vocabulary, so exercising the
 * real data through the real `buildTaxonomyIndex` is more faithful than a
 * synthetic stand-in and still fully deterministic.
 */
export function makeTaxonomyIndex(config: AlgorithmConfig = DEFAULT_CONFIG): TaxonomyIndex {
  return buildTaxonomyIndex(DEFAULT_TAXONOMY, config);
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

/**
 * Small synthetic location set with distances chosen (and verified via the
 * production haversine formula) to land deliberately in each configured
 * band, so location-compatibility tests don't depend on incidental
 * real-world distances between CMU buildings:
 *  - `loc-a` <-> `loc-b`  ~33 m   (inside the 250 m band)
 *  - `loc-a` <-> `loc-c`  ~500 m  (inside the 800 m band, outside 250 m)
 *  - `loc-a` <-> `loc-d`  ~5.0 km (same campus, outside every band)
 *  - `loc-a` <-> `loc-e`  ~50 km  (different campus, outside every band)
 * `loc-unknown` is intentionally NOT registered, for "unknown id" tests.
 */
export const TEST_LOCATIONS: CanonicalLocation[] = [
  { id: 'loc-a', name: 'Location A', latitude: 40.4425, longitude: -79.9425, campusId: 'campus-main' },
  { id: 'loc-b', name: 'Location B', latitude: 40.4428, longitude: -79.9425, campusId: 'campus-main' },
  { id: 'loc-c', name: 'Location C', latitude: 40.447, longitude: -79.9425, campusId: 'campus-main' },
  { id: 'loc-d', name: 'Location D', latitude: 40.4875, longitude: -79.9425, campusId: 'campus-main' },
  { id: 'loc-e', name: 'Location E', latitude: 40.8925, longitude: -79.9425, campusId: 'campus-other' },
];

export const TEST_LOCATION_CONFIG: LocationConfig = { locations: TEST_LOCATIONS };

export function makeLocationService(): LocationService {
  return createLocationService(TEST_LOCATION_CONFIG);
}

// ---------------------------------------------------------------------------
// Events / intents
// ---------------------------------------------------------------------------

/** A plain, mid-window OPEN event: starts in 30 min, 60 min long, plenty of capacity left. */
export function makeEvent(overrides: Partial<MatchableEvent> = {}): MatchableEvent {
  const base: MatchableEvent = {
    id: 'event-1',
    creatorId: 'user-creator',
    status: 'OPEN',
    activityId: 'treadmill',
    categoryId: 'fitness',
    tags: ['treadmill', 'cardio', 'workout'],
    startTime: new Date(NOW.getTime() + 30 * 60_000),
    endTime: new Date(NOW.getTime() + 90 * 60_000),
    locationId: 'loc-a',
    capacity: 6,
    participantCount: 1,
    participantIds: ['user-creator'],
    createdAt: new Date(NOW.getTime() - 10 * 60_000),
    expiresAt: new Date(NOW.getTime() + 120 * 60_000),
  };
  return { ...base, ...overrides };
}

/** A `NormalizedIntent` matching `makeEvent()`'s defaults closely enough to score well. */
export function makeIntent(overrides: Partial<NormalizedIntent> = {}): NormalizedIntent {
  const base: NormalizedIntent = {
    activityIds: ['treadmill'],
    categoryIds: [],
    tags: ['treadmill', 'cardio'],
    startTime: new Date(NOW.getTime() + 30 * 60_000),
    endTime: new Date(NOW.getTime() + 90 * 60_000),
    locationIds: ['loc-a'],
    sourceText: 'treadmill',
  };
  return { ...base, ...overrides };
}
