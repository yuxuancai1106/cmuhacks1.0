/**
 * Canonicalization of untrusted client input into the `NormalizedIntent` every
 * deterministic stage (retrieval, hard filtering, scoring, cache keys) runs on.
 *
 * Everything in this module is **pure and synchronous**: no I/O, no clock read,
 * and — critically — no LLM. `recommend` (the real-time advisory path) depends
 * on that property to guarantee zero LLM calls, and `match` uses it as the
 * structured half of its merge with the semantic interpretation.
 *
 * Trust model: `RawIntent` arrives from the client and is never believed.
 * Activity ids that are not in the controlled vocabulary are dropped, and
 * location ids that the `LocationService` does not know are dropped. Derived
 * fields (`categoryIds`, `tags`) are computed here from the taxonomy rather
 * than accepted from the caller, so a client cannot inject a category or tag
 * that the vocabulary does not actually assign.
 */
import type {
  ActivityId,
  CategoryId,
  LocationId,
  LocationService,
  NormalizedIntent,
  RawIntent,
  TaxonomyIndex,
} from './types.js';
import type { AlgorithmConfig } from '../config/types.js';
import { normalizeText, tokenize } from './text.js';

export interface NormalizeStructuredIntentArgs {
  intent: RawIntent;
  taxonomy: TaxonomyIndex;
  locations: LocationService;
  /**
   * Part of the pinned signature and passed by every caller for a uniform
   * call shape. Structural normalization is currently driven entirely by the
   * taxonomy and the location catalogue, so nothing here reads a tuning knob
   * — deliberately not destructured, rather than silently ignored.
   */
  config: AlgorithmConfig;
}

/** Dedupe preserving first-seen order, so output ordering is deterministic. */
function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/**
 * Canonical, LLM-free normalization of a raw client intent.
 *
 * - `activityIds`: only ids present in the controlled vocabulary survive.
 * - `categoryIds`: derived from the surviving activities (never client-supplied).
 * - `tags`: union of `taxonomy.tagsFor` over the surviving activities, de-duplicated.
 * - `locationIds`: explicit ids win, but only the ones the `LocationService`
 *   actually knows. If nothing explicit survives validation we fall through to
 *   `coordinates` -> `resolveNearestLocation`. A client that sends only bogus
 *   location ids therefore gets "no location constraint" (or its device
 *   position), never a fabricated location.
 * - `sourceText`: the normalized free text, or `undefined` when there is none.
 *   Kept for cache keys, relative-time parsing and debugging only.
 */
export function normalizeStructuredIntent(args: NormalizeStructuredIntentArgs): NormalizedIntent {
  const { intent, taxonomy, locations } = args;

  const activityIds = dedupe(intent.activityIds ?? []).filter((id) => taxonomy.hasActivity(id));

  const categoryIds = dedupe(
    activityIds
      .map((id) => taxonomy.categoryOf(id))
      .filter((id): id is CategoryId => id !== undefined),
  );

  const tags = dedupe(activityIds.flatMap((id) => taxonomy.tagsFor(id)));

  const locationIds = resolveLocationIds(intent, locations);

  const normalizedText = intent.text === undefined ? '' : normalizeText(intent.text);

  return {
    activityIds,
    categoryIds,
    tags,
    locationIds,
    sourceText: normalizedText.length > 0 ? normalizedText : undefined,
  };
}

function resolveLocationIds(intent: RawIntent, locations: LocationService): LocationId[] {
  const explicit = dedupe(intent.locationIds ?? []).filter(
    (id) => locations.getLocation(id) !== undefined,
  );
  if (explicit.length > 0) return explicit;

  const coordinates = intent.coordinates;
  if (coordinates !== undefined) {
    const nearest = locations.resolveNearestLocation(coordinates.latitude, coordinates.longitude);
    if (nearest !== null) return [nearest.id];
  }

  return [];
}

/**
 * The deterministic-only text path used by `recommend`.
 *
 * Resolution order, per spec: exact controlled-vocabulary id on the whole
 * normalized string -> synonym on the whole normalized string -> best single
 * token. Among matching tokens the **longest wins** (a longer word is the more
 * specific, less ambiguous signal); ties keep the **leftmost** match, since
 * tokens are scanned left-to-right and only a strictly longer token displaces
 * the incumbent.
 *
 * Returns `undefined` rather than guessing. Callers on the real-time path must
 * treat `undefined` as "no activity" and stop — they may not escalate to an LLM.
 *
 * NOTE: `src/semantic/parser.ts` contains the same two-stage logic privately
 * (`deterministicLookup` + `bestTokenMatch`). That duplication is deliberate
 * here only because the parser does not export those helpers and this lane may
 * not modify that file; see the final report.
 */
export function deterministicActivityFromText(
  text: string,
  taxonomy: TaxonomyIndex,
): ActivityId | undefined {
  const normalized = normalizeText(text);
  if (normalized.length === 0) return undefined;

  if (taxonomy.hasActivity(normalized)) return normalized;
  const wholeTextSynonym = taxonomy.resolveSynonym(normalized);
  if (wholeTextSynonym !== undefined) return wholeTextSynonym;

  let winner: { id: ActivityId; tokenLength: number } | undefined;
  for (const token of tokenize(normalized)) {
    const match = taxonomy.hasActivity(token) ? token : taxonomy.resolveSynonym(token);
    if (match === undefined) continue;
    if (winner === undefined || token.length > winner.tokenLength) {
      winner = { id: match, tokenLength: token.length };
    }
  }
  return winner?.id;
}
