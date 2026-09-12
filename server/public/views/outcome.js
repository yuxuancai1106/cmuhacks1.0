/**
 * What actually happened.
 *
 * Deliberately a different object from the pipeline: the pipeline is a dashed,
 * hatched *prediction*; this is a solid, stamped, timestamped receipt of a write
 * that has already occurred. It also states whether the prediction held.
 */
import { h, fill, icon } from '../lib/dom.js';
import { titleize, timeRange, score, clockTime } from '../lib/format.js';
import { outcomeKey, shortId } from './pipeline.js';

const STATUS_WORD = { MATCHED: 'Joined an event', PENDING: 'Created an event', REJECTED: 'Nothing to match' };
const STATUS_LINE = {
  MATCHED: 'You were added to an existing event.',
  PENDING: 'No candidate cleared the threshold, so a new open event was created.',
  REJECTED: 'Nothing in the intent resolved to the controlled vocabulary, so nothing was written.',
};

export function renderOutcome(root, record, ctx) {
  if (!record) {
    fill(root, h('div', { class: 'awaiting' },
      'Nothing written yet. ',
      h('br'),
      'Submit an intent to call ', h('code', { text: 'POST /api/match' }), '.'));
    return;
  }

  const { outcome, at, prediction } = record;
  const status = outcome.status;
  const event = outcome.event;

  const rows = [];
  if (outcome.eventId) rows.push(row('Event', shortId(outcome.eventId)));
  if (event) {
    rows.push(row('Activity', titleize(event.activityId)));
    rows.push(row('Where', ctx.locationName(event.locationId)));
    rows.push(row('When', timeRange(event.startTime, event.endTime)));
    rows.push(row('Seats', `${event.participantCount}/${event.capacity}`));
  }
  if (typeof outcome.score === 'number') rows.push(row('Score', score(outcome.score)));
  if (typeof outcome.bestRejectedScore === 'number') rows.push(row('Best seen', score(outcome.bestRejectedScore)));
  rows.push(row('Semantic', outcome.semanticSource ?? 'NONE'));
  if (outcome.reason) rows.push(row('Reason', outcome.reason));
  if (outcome.idempotentReplay) rows.push(row('Replay', 'idempotent'));

  const verdict = compare(prediction, outcome);

  // The receipt is coloured by what was COMMITTED, never by the live
  // prediction — otherwise editing the intent would recolour history.
  fill(root, h('div', { class: 'receipt', dataset: { kind: outcomeKey(status) } },
    h('div', { class: 'receipt-top' },
      h('p', { class: 'receipt-stamp' }, icon('i-check'), 'Committed · ', clockTime(at)),
      h('p', { class: 'receipt-status', text: STATUS_WORD[status] ?? status }),
      h('p', { class: 'receipt-line', text: STATUS_LINE[status] ?? '' }),
    ),
    h('dl', { class: 'receipt-body' }, rows),
    verdict ? h('p', { class: `receipt-foot ${verdict.ok ? 'is-match' : 'is-miss'}` },
      icon(verdict.ok ? 'i-check' : 'i-cross'), verdict.text) : null,
  ));
}

function row(key, value) {
  return h('div', { class: 'receipt-row' }, h('dt', { text: key }), h('dd', { text: String(value) }));
}

/** Did the read-only prediction hold once the authoritative path ran? */
function compare(prediction, outcome) {
  if (!prediction || !prediction.kind) return null;
  const predicted = outcomeKey(prediction.kind);
  const actual = outcomeKey(outcome.status);
  const sameEvent = prediction.eventId && outcome.eventId
    ? prediction.eventId === outcome.eventId : null;

  if (predicted === actual) {
    return {
      ok: true,
      text: sameEvent === false
        ? `Prediction held (${prediction.kind}), but on a different event — the authoritative path revalidated.`
        : `Prediction held: ${prediction.kind} matched the committed ${outcome.status}.`,
    };
  }
  return { ok: false, text: `Prediction said ${prediction.kind}; the authoritative path committed ${outcome.status}. Advisory results can go stale — only /api/match decides.` };
}

export function outcomeAccent(status) {
  return outcomeKey(status);
}
