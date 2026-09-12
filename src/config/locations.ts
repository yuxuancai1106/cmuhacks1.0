import type { CanonicalLocation } from '../core/types.js';
import type { LocationConfig } from './types.js';

/**
 * Canonical Carnegie Mellon (Pittsburgh) campus locations with approximate
 * real-world coordinates. These are deliberately coarse (building-centroid,
 * not entrance-precise) — good enough for "which building is this near"
 * resolution and campus-scale distance banding, not for turn-by-turn routing.
 *
 * `campusId: 'cmu-pittsburgh'` covers on-campus academic/residential/athletic
 * buildings. Schenley Park and Craig Street are genuinely off-campus (a public
 * park and a commercial street bordering campus, respectively) — giving them
 * the same campusId as academic buildings would make "same campus" scoring
 * lie about adjacency that isn't really "on campus". They get their own
 * campusId (`schenley-park`, `craig-street`) so they only score well via the
 * distance bands (which they will, since they're close), not via the
 * same-campus floor.
 */
const CMU_PITTSBURGH = 'cmu-pittsburgh';

const RAW_LOCATIONS: CanonicalLocation[] = [
  {
    id: 'cohon-university-center',
    name: 'Cohon University Center',
    latitude: 40.4425,
    longitude: -79.9425,
    campusId: CMU_PITTSBURGH,
  },
  {
    id: 'gesling-stadium',
    name: 'Gesling Stadium',
    latitude: 40.4453,
    longitude: -79.9439,
    campusId: CMU_PITTSBURGH,
  },
  {
    id: 'tepper-building',
    name: 'Tepper Building',
    latitude: 40.4444,
    longitude: -79.9451,
    campusId: CMU_PITTSBURGH,
  },
  {
    id: 'gates-hillman',
    name: 'Gates Hillman Center',
    latitude: 40.4433,
    longitude: -79.9436,
    campusId: CMU_PITTSBURGH,
  },
  {
    id: 'newell-simon',
    name: 'Newell-Simon Hall',
    latitude: 40.4428,
    longitude: -79.9438,
    campusId: CMU_PITTSBURGH,
  },
  {
    id: 'wean-hall',
    name: 'Wean Hall',
    latitude: 40.4423,
    longitude: -79.9441,
    campusId: CMU_PITTSBURGH,
  },
  {
    id: 'doherty-hall',
    name: 'Doherty Hall',
    latitude: 40.4419,
    longitude: -79.9438,
    campusId: CMU_PITTSBURGH,
  },
  {
    id: 'baker-porter-hall',
    name: 'Baker/Porter Hall',
    latitude: 40.4415,
    longitude: -79.9445,
    campusId: CMU_PITTSBURGH,
  },
  {
    id: 'hunt-library',
    name: 'Hunt Library',
    latitude: 40.4417,
    longitude: -79.9436,
    campusId: CMU_PITTSBURGH,
  },
  {
    id: 'sorrells-library',
    name: 'Sorrells Engineering & Science Library',
    latitude: 40.4429,
    longitude: -79.9432,
    campusId: CMU_PITTSBURGH,
  },
  {
    id: 'purnell-center',
    name: 'Purnell Center for the Arts',
    latitude: 40.4409,
    longitude: -79.9432,
    campusId: CMU_PITTSBURGH,
  },
  {
    id: 'college-of-fine-arts',
    name: 'College of Fine Arts',
    latitude: 40.4412,
    longitude: -79.9427,
    campusId: CMU_PITTSBURGH,
  },
  {
    id: 'margaret-morrison',
    name: 'Margaret Morrison Carnegie Hall',
    latitude: 40.4407,
    longitude: -79.9425,
    campusId: CMU_PITTSBURGH,
  },
  {
    id: 'scaife-hall',
    name: 'Scaife Hall',
    latitude: 40.4438,
    longitude: -79.9459,
    campusId: CMU_PITTSBURGH,
  },
  {
    id: 'hamerschlag-hall',
    name: 'Hamerschlag Hall',
    latitude: 40.4421,
    longitude: -79.9459,
    campusId: CMU_PITTSBURGH,
  },
  {
    id: 'schenley-park',
    name: 'Schenley Park',
    latitude: 40.4373,
    longitude: -79.9422,
    campusId: 'schenley-park',
  },
  {
    id: 'craig-street',
    name: 'Craig Street',
    latitude: 40.4453,
    longitude: -79.9469,
    campusId: 'craig-street',
  },
];

export const CMU_LOCATIONS: LocationConfig = {
  locations: RAW_LOCATIONS,
};

/**
 * Build a `LocationConfig`, optionally replacing the canonical CMU list
 * wholesale. Passing `overrides` swaps in a caller-supplied config entirely
 * (e.g. for tests with a small synthetic location set) rather than merging,
 * since a partial merge of a location *list* has no obviously-correct
 * semantics (dedupe by id? append? replace?) — callers who want a variant of
 * the CMU set should spread `CMU_LOCATIONS.locations` themselves.
 */
export function buildLocationConfig(overrides?: LocationConfig): LocationConfig {
  if (!overrides) return CMU_LOCATIONS;
  return overrides;
}
