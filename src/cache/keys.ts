/**
 * Pure, deterministic cache-key builders. No I/O, no clock reads beyond the
 * `Date` values callers pass in.
 *
 * Rules baked into every builder here:
 *  - Id-array inputs are order-insensitive: they are sorted before joining so
 *    that `{a,b}` and `{b,a}` always produce the identical key.
 *  - Time is never embedded as an exact timestamp — only as a bucket index
 *    (`Math.floor(t / bucketMs)`) — so requests a few seconds/minutes apart
 *    (depending on the configured bucket width) can share one cache entry.
 *  - Any text segment that could grow unbounded (free-form user text, or in
 *    principle a very large id list) is passed through `boundedText`, which
 *    hashes it with FNV-1a once it exceeds a small fixed length. This keeps
 *    every generated key short and bounded regardless of input size, at the
 *    cost of that segment no longer being human-readable once hashed.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** 32-bit FNV-1a hash, rendered as an 8-character hex string. No runtime deps. */
function fnv1a(input: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const MAX_SEGMENT_LENGTH = 64;

/** Truncates long text and appends a hash so distinct long inputs cannot collide once cut. */
export function boundedText(text: string): string {
  if (text.length <= MAX_SEGMENT_LENGTH) return text;
  return `${text.slice(0, MAX_SEGMENT_LENGTH)}~${fnv1a(text)}`;
}

/** Sorts (order-insensitive) and joins an id list, then bounds the result. */
function idListSegment(ids: string[]): string {
  return boundedText([...ids].sort().join(','));
}

export function semanticKey(normalizedText: string): string {
  return `semantic:${boundedText(normalizedText)}`;
}

/**
 * Key for the real-time recommendation cache.
 * Format: `recommendations:{activities}:{categories}:{locations}:{timeBucket}`.
 * The spec's format shows activities/locations/bucket and separately notes
 * "include categories too" without pinning where; this places categories
 * immediately after activities since both describe "what", before "where"
 * (locations) and "when" (the bucket).
 */
export function recommendationKey(args: {
  activityIds: string[];
  categoryIds: string[];
  locationIds: string[];
  startTime?: Date;
  now: Date;
  bucketMs: number;
}): string {
  const { activityIds, categoryIds, locationIds, startTime, now, bucketMs } = args;
  const anchor = startTime ?? now;
  const bucket = Math.floor(anchor.getTime() / bucketMs);
  return `recommendations:${idListSegment(activityIds)}:${idListSegment(categoryIds)}:${idListSegment(locationIds)}:${bucket}`;
}

/** Key for personalized activity suggestions. `bucket` is precomputed by the caller. */
export function suggestionsKey(userId: string, bucket: number, locationId?: string): string {
  const base = `suggestions:${boundedText(userId)}:${bucket}`;
  return locationId === undefined ? base : `${base}:${boundedText(locationId)}`;
}
