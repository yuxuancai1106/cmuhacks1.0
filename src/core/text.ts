/**
 * Dependency-free, allocation-light text normalization. Runs on every
 * request (semantic parsing, cache-key construction), so it deliberately
 * avoids anything heavier than string/regex operations.
 */

/** `!?.,;:` plus straight/curly quotes. A run of these collapses to one space. */
const PUNCTUATION_RE = /[!?.,;:'"‘’“”]+/g;
const WHITESPACE_RE = /\s+/g;

/**
 * Lowercase, strip simple punctuation, collapse whitespace, trim.
 * `"  TREADMILL!! "` and `"treadmill"` normalize to the same string, which
 * is the property every cache key and taxonomy lookup in this codebase
 * depends on.
 */
export function normalizeText(input: string): string {
  const lowered = input.toLowerCase();
  // Replace punctuation runs with a single space (not empty) so stripping
  // punctuation never fuses two adjacent words together.
  const withoutPunctuation = lowered.replace(PUNCTUATION_RE, ' ');
  const collapsed = withoutPunctuation.replace(WHITESPACE_RE, ' ');
  return collapsed.trim();
}

/**
 * Small built-in stopword list. Deliberately includes "work" (not just
 * "workout") per spec, since generic filler like "work on my ..." should not
 * itself be mistaken for an activity token.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'my', 'on', 'at', 'to', 'for', 'with', 'i',
  'want', 'wanna', 'gonna', 'some', 'go', 'do', 'work',
]);

/** Normalized word tokens with stopwords removed. */
export function tokenize(input: string): string[] {
  const normalized = normalizeText(input);
  if (normalized.length === 0) return [];

  const tokens: string[] = [];
  for (const token of normalized.split(' ')) {
    if (token.length > 0 && !STOPWORDS.has(token)) {
      tokens.push(token);
    }
  }
  return tokens;
}
