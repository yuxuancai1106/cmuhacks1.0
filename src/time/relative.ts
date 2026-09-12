/**
 * Deterministic parsing of relative/vague time phrases out of already
 * LLM-normalized free text. This module performs *zero* arithmetic decisions
 * on behalf of an LLM — the LLM's job (elsewhere) is limited to extracting
 * activity semantics; converting "in 30 minutes" into an actual `Date` is a
 * pure regex + `Date` computation, always reproducible from the same
 * `(normalizedText, now)` pair.
 *
 * Timezone assumption: every computed `Date` is built from `now`'s local
 * calendar date/time (via `Date`'s local-time constructor overload:
 * `getFullYear()`/`getMonth()`/`getDate()` plus an explicit hour/minute).
 * This module does not know or apply any particular user's timezone — it
 * resolves "tonight" or "at 7pm" relative to whatever timezone the process
 * (and therefore `now`) is running in. The surrounding app owns timezone
 * policy: if a user's wall-clock timezone differs from the server's, the
 * caller is responsible for running this against a `now`/environment that
 * reflects the user's local time, or for re-interpreting the result.
 */

/**
 * Hour-of-day (24h, local time) that each vague day-part phrase resolves to.
 * Exported so the mapping is configurable and independently testable rather
 * than buried in regex-handling logic.
 */
export const DAY_PART_HOUR_OF_DAY = {
  morning: 9,
  afternoon: 14,
  evening: 18,
  /** "tonight" */
  night: 20,
} as const;

interface DayPartPattern {
  pattern: RegExp;
  hour: number;
  /** 0 = today, 1 = tomorrow. */
  dayOffset: 0 | 1;
}

// Longer/more specific phrases are irrelevant to order here since each
// pattern is a distinct literal phrase (no phrase is a substring of another
// in a way that would change which one matches), but "tomorrow morning" is
// still listed ahead of "this morning" for readability.
const DAY_PART_PATTERNS: DayPartPattern[] = [
  { pattern: /\btonight\b/i, hour: DAY_PART_HOUR_OF_DAY.night, dayOffset: 0 },
  { pattern: /\bthis\s+evening\b/i, hour: DAY_PART_HOUR_OF_DAY.evening, dayOffset: 0 },
  { pattern: /\bthis\s+afternoon\b/i, hour: DAY_PART_HOUR_OF_DAY.afternoon, dayOffset: 0 },
  { pattern: /\btomorrow\s+morning\b/i, hour: DAY_PART_HOUR_OF_DAY.morning, dayOffset: 1 },
  { pattern: /\bthis\s+morning\b/i, hour: DAY_PART_HOUR_OF_DAY.morning, dayOffset: 0 },
];

const RE_NOW_ASAP = /\b(?:right now|now|asap)\b/i;
const RE_IN_HOURS = /\bin\s+(an?|\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i;
const RE_IN_MINUTES = /\bin\s+(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/i;
/** `at 7`, `at 7pm`, `at 7:30`, `at 19:30`. */
const RE_AT_CLOCK = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;

function atLocalHour(now: Date, hour: number, minute: number, dayOffset: number): Date {
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + dayOffset,
    hour,
    minute,
    0,
    0,
  );
}

function parseInHoursMinutes(text: string): number | null {
  const hoursMatch = RE_IN_HOURS.exec(text);
  if (hoursMatch) {
    const raw = hoursMatch[1] ?? '';
    const value = /^an?$/i.test(raw) ? 1 : Number(raw);
    if (Number.isFinite(value) && value > 0) return value * 60;
  }

  const minutesMatch = RE_IN_MINUTES.exec(text);
  if (minutesMatch) {
    const raw = minutesMatch[1] ?? '';
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return value;
  }

  return null;
}

interface ClockTime {
  hour: number;
  minute: number;
}

/**
 * Parses `at <clock time>` phrases. A bare hour with no am/pm suffix (`at 7`)
 * is interpreted literally as a 24-hour value (07:00, not 19:00) — this is
 * the resolved ambiguity for this module: pair a bare hour with `am`/`pm`,
 * or use 24-hour notation (`at 19:30`), to name an evening time unambiguously.
 */
function parseAtClock(text: string): ClockTime | null {
  const match = RE_AT_CLOCK.exec(text);
  if (!match) return null;

  const hourRaw = match[1];
  if (hourRaw === undefined) return null;
  const minuteRaw = match[2];
  const meridiem = match[3]?.toLowerCase();

  let hour = Number(hourRaw);
  const minute = minuteRaw === undefined ? 0 : Number(minuteRaw);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (minute < 0 || minute > 59) return null;

  if (meridiem === 'pm') {
    if (hour < 1 || hour > 12) return null;
    hour = hour === 12 ? 12 : hour + 12;
  } else if (meridiem === 'am') {
    if (hour < 1 || hour > 12) return null;
    hour = hour === 12 ? 0 : hour;
  } else if (hour < 0 || hour > 23) {
    return null;
  }

  return { hour, minute };
}

/**
 * Parses a deterministic relative-time phrase out of `normalizedText`,
 * anchored to the injected `now`. Never throws; returns `null` when nothing
 * recognizable is found so the caller can fall through to the next
 * time-resolution strategy.
 *
 * Match precedence when a text contains more than one kind of phrase (rare,
 * but e.g. "asap" combined with an explicit clock time): `now`/`asap` >
 * `in N minutes/hours` > `at <clock time>` > vague day-part phrases. This
 * favors the most explicit/quantitative signal first.
 */
export function parseRelativeTime(normalizedText: string, now: Date): { startTime: Date } | null {
  const text = normalizedText ?? '';

  if (RE_NOW_ASAP.test(text)) {
    return { startTime: new Date(now.getTime()) };
  }

  const minutesFromNow = parseInHoursMinutes(text);
  if (minutesFromNow !== null) {
    return { startTime: new Date(now.getTime() + minutesFromNow * 60_000) };
  }

  const clock = parseAtClock(text);
  if (clock) {
    const todayAtClock = atLocalHour(now, clock.hour, clock.minute, 0);
    // "Next occurrence": a clock time already passed today (or equal to
    // `now`) means tomorrow, not a moment in the past.
    const resolved =
      todayAtClock.getTime() <= now.getTime()
        ? atLocalHour(now, clock.hour, clock.minute, 1)
        : todayAtClock;
    return { startTime: resolved };
  }

  for (const dayPart of DAY_PART_PATTERNS) {
    if (dayPart.pattern.test(text)) {
      return { startTime: atLocalHour(now, dayPart.hour, 0, dayPart.dayOffset) };
    }
  }

  return null;
}

/** Every pattern `parseRelativeTime` recognizes, for use by `stripTimePhrases`. */
const ALL_TIME_PATTERNS: RegExp[] = [
  RE_IN_HOURS,
  RE_IN_MINUTES,
  RE_AT_CLOCK,
  RE_NOW_ASAP,
  ...DAY_PART_PATTERNS.map((d) => d.pattern),
];

/**
 * Removes one matched time phrase from the leading or trailing edge of
 * `normalizedText`, so the remainder can be parsed as the activity itself
 * (e.g. `"treadmill in 30 minutes"` -> `"treadmill"`). A phrase matched in
 * the *middle* of the text is left alone — stripping it could otherwise
 * mangle unrelated activity text (e.g. "the gym at the corner"), so only an
 * edge match is treated as a genuine time qualifier rather than incidental
 * text.
 */
export function stripTimePhrases(normalizedText: string): string {
  const trimmed = (normalizedText ?? '').trim();
  if (trimmed.length === 0) return trimmed;

  for (const pattern of ALL_TIME_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (!match) continue;

    const matchedText = match[0] ?? '';
    const start = match.index;
    const end = start + matchedText.length;

    if (start === 0) return trimmed.slice(end).trim();
    if (end === trimmed.length) return trimmed.slice(0, start).trim();
  }

  return trimmed;
}
