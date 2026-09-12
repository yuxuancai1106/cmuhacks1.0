/**
 * Presentation-only formatting. Nothing here invents a value: every function
 * takes something the API returned and decides how to spell it.
 */

/** `treadmill` -> `Treadmill`, `cohon-university-center` -> `Cohon University Center`. */
export function titleize(id) {
  if (typeof id !== 'string' || id.length === 0) return '';
  return id
    .split(/[-_]/)
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

/** `WOULD_JOIN` -> `Would join`. Enum values are shown verbatim where they are ids. */
export function humanizeEnum(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  const spaced = value.replace(/_/g, ' ').toLowerCase();
  return spaced[0].toUpperCase() + spaced.slice(1);
}

const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const DAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const STAMP_FMT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "Today 6:00 – 7:00 PM" / "Fri, Oct 3 6:00 – 7:00 PM". */
export function timeRange(startIso, endIso) {
  const start = toDate(startIso);
  if (!start) return '';
  const end = toDate(endIso);
  const now = new Date();
  const day = sameDay(start, now) ? 'Today' : DAY_FMT.format(start);
  return end ? `${day} ${TIME_FMT.format(start)} – ${TIME_FMT.format(end)}` : `${day} ${TIME_FMT.format(start)}`;
}

export function clockTime(iso) {
  const d = toDate(iso);
  return d ? STAMP_FMT.format(d) : '';
}

export function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Scores and weights: fixed 2 decimals, tabular. */
export function score(n, digits = 2) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(digits) : '—';
}

export function integer(n) {
  return typeof n === 'number' && Number.isFinite(n) ? String(Math.round(n)) : '—';
}

/** `<input type="datetime-local">` wants local time without a zone suffix. */
export function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Deterministic, stable colour per user id — presentation only. */
const USER_HUES = [152, 210, 33, 280, 8, 190];
export function userStyle(userId) {
  let sum = 0;
  for (let i = 0; i < String(userId).length; i += 1) sum += String(userId).charCodeAt(i);
  const hue = USER_HUES[sum % USER_HUES.length];
  return { '--u-bg': `oklch(70% .13 ${hue} / .22)`, '--u-ink': `oklch(78% .13 ${hue})` };
}

export function initials(userId) {
  const s = String(userId ?? '').trim();
  if (s.length === 0) return '?';
  return s.slice(0, 2).toUpperCase();
}
