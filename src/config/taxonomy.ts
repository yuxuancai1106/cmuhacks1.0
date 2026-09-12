import type { ActivityNode, TaxonomyConfig } from './types.js';
import { normalizeText } from '../core/text.js';

const CATEGORIES: TaxonomyConfig['categories'] = [
  { id: 'fitness', name: 'Fitness' },
  { id: 'coding', name: 'Coding' },
  { id: 'art', name: 'Art' },
  { id: 'study', name: 'Study' },
  { id: 'social', name: 'Social' },
];

/**
 * The controlled activity vocabulary. Parent/child edges structurally encode
 * similarity so `TaxonomyIndex.similarity` needs no LLM call. See
 * `src/core/taxonomyIndex.ts` for how relations/hops turn into scores.
 */
const ACTIVITIES: ActivityNode[] = [
  // --- fitness -------------------------------------------------------
  // `workout` is the fitness root. `treadmill` sits directly under it (one
  // hop), so treadmill<->workout scores at the full, undecayed `parent`
  // value. `running` is also a direct child of `workout`, but is
  // additionally cross-linked to `treadmill` via `relatedIds`: those two are
  // a much closer pair (treadmill running is a form of running) than two
  // arbitrary workout children, so they resolve to RELATED rather than the
  // weaker generic SIBLING relation.
  // `basketball` is a separate root in the same category: it shares no
  // ancestor with `workout`/`treadmill`/`running`, so it only reaches
  // SAME_CATEGORY similarity against them -- deliberately lower than
  // treadmill<->workout, since basketball is a much less central "workout".
  { id: 'workout', categoryId: 'fitness', tags: ['workout', 'fitness', 'exercise', 'gym'] },
  {
    id: 'running',
    categoryId: 'fitness',
    parentId: 'workout',
    tags: ['running', 'run', 'jog', 'cardio', 'workout'],
    relatedIds: ['treadmill'],
  },
  {
    id: 'treadmill',
    categoryId: 'fitness',
    parentId: 'workout',
    tags: ['treadmill', 'running', 'cardio', 'workout'],
    relatedIds: ['running'],
  },
  { id: 'basketball', categoryId: 'fitness', tags: ['basketball', 'sports', 'workout'] },

  // --- coding ----------------------------------------------------------
  { id: 'coding', categoryId: 'coding', tags: ['coding', 'programming', 'tech'] },
  {
    id: 'programming',
    categoryId: 'coding',
    parentId: 'coding',
    tags: ['programming', 'coding', 'software', 'dev'],
  },
  {
    id: 'robotics',
    categoryId: 'coding',
    parentId: 'coding',
    tags: ['robotics', 'coding', 'engineering', 'hardware'],
  },

  // --- art ---------------------------------------------------------------
  { id: 'drawing', categoryId: 'art', tags: ['drawing', 'art', 'sketch'] },
  { id: 'painting', categoryId: 'art', parentId: 'drawing', tags: ['painting', 'drawing', 'art'] },
  // `photography` is its own root in `art` (per spec), not a child of drawing.
  { id: 'photography', categoryId: 'art', tags: ['photography', 'art', 'camera', 'photo'] },

  // --- study -------------------------------------------------------------
  { id: 'studying', categoryId: 'study', tags: ['studying', 'study', 'school', 'academic'] },
  {
    id: 'homework',
    categoryId: 'study',
    parentId: 'studying',
    tags: ['homework', 'studying', 'school', 'assignment'],
  },

  // --- social -- three independent roots; no structural relation between
  // them beyond sharing a category (spec: "walking (root); coffee (root);
  // lunch (root)").
  { id: 'walking', categoryId: 'social', tags: ['walking', 'walk', 'social'] },
  { id: 'coffee', categoryId: 'social', tags: ['coffee', 'cafe', 'social', 'drink'] },
  { id: 'lunch', categoryId: 'social', tags: ['lunch', 'food', 'social', 'meal'] },
];

/**
 * Alias -> canonical activity id. Note "programming" and "coding" are each
 * their own controlled-vocabulary activity id (see ACTIVITIES above), so
 * they are deliberately NOT listed here as synonym keys pointing at a
 * different id -- the deterministic parser resolves a known activity id via
 * exact match before it ever consults this map, so such an entry would be
 * unreachable and, worse, misleading to read.
 */
const SYNONYMS: Record<string, string> = {
  gym: 'workout',
  exercise: 'workout',
  exercising: 'workout',
  cardio: 'workout',

  jog: 'running',
  jogging: 'running',
  run: 'running',
  runs: 'running',
  sprint: 'running',
  sprinting: 'running',

  hoops: 'basketball',
  bball: 'basketball',

  code: 'coding',
  coder: 'programming',
  coders: 'programming',
  program: 'programming',
  programs: 'programming',
  software: 'programming',
  dev: 'programming',
  developing: 'programming',
  development: 'programming',

  robot: 'robotics',
  robots: 'robotics',

  draw: 'drawing',
  drawings: 'drawing',
  sketch: 'drawing',
  sketching: 'drawing',
  paint: 'painting',

  photo: 'photography',
  photos: 'photography',
  pic: 'photography',
  pics: 'photography',
  camera: 'photography',

  study: 'studying',
  studies: 'studying',
  hw: 'homework',
  assignment: 'homework',
  assignments: 'homework',

  walk: 'walking',
  stroll: 'walking',
  strolling: 'walking',
  cafe: 'coffee',
  starbucks: 'coffee',
  eat: 'lunch',
  eating: 'lunch',
  food: 'lunch',
};

/**
 * Dev-time guard: every synonym key must already be what `normalizeText`
 * would produce, since `TaxonomyIndex.resolveSynonym` looks keys up verbatim
 * against already-normalized input and never re-normalizes them itself.
 * Runs once at module load, against this small static map.
 */
function assertNormalizedSynonymKeys(synonyms: Record<string, string>): void {
  for (const key of Object.keys(synonyms)) {
    if (key !== normalizeText(key)) {
      throw new Error(
        `taxonomy synonym key "${key}" is not normalized (expected "${normalizeText(key)}")`,
      );
    }
  }
}

assertNormalizedSynonymKeys(SYNONYMS);

export const DEFAULT_TAXONOMY: TaxonomyConfig = {
  categories: CATEGORIES,
  activities: ACTIVITIES,
  synonyms: SYNONYMS,
};

/**
 * Merge a partial override onto the default taxonomy. Arrays (categories,
 * activities) are replaced wholesale when provided, matching the
 * `resolveConfig` convention in `src/config/defaults.ts`; `synonyms` is
 * merged key-by-key so callers can add aliases without repeating the map.
 */
export function buildTaxonomy(overrides?: Partial<TaxonomyConfig>): TaxonomyConfig {
  if (!overrides) return DEFAULT_TAXONOMY;
  return {
    categories: overrides.categories ?? DEFAULT_TAXONOMY.categories,
    activities: overrides.activities ?? DEFAULT_TAXONOMY.activities,
    synonyms: { ...DEFAULT_TAXONOMY.synonyms, ...(overrides.synonyms ?? {}) },
  };
}
