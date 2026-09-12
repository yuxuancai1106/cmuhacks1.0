/**
 * Ranked candidates.
 *
 * The bar under each card is the scoring function drawn literally: each of the
 * five segments is as wide as its configured weight, and fills to that
 * dimension's score. The total filled fraction of the track therefore *is* the
 * composite score, and the tick is the configured match threshold.
 */
import { h, fill } from '../lib/dom.js';
import { titleize, timeRange, score } from '../lib/format.js';
import { stagger } from '../lib/anim.js';
import { shortId } from './pipeline.js';

const DIMS = ['activity', 'time', 'location', 'tag', 'quality'];

export function renderCandidates(root, { ranked, weights, threshold, ctx, degraded }) {
  if (!ranked || ranked.length === 0) {
    fill(root, h('div', { class: 'empty' },
      h('strong', { text: degraded ? 'No ranking available' : 'No candidates yet' }),
      degraded
        ? 'The pipeline inspector is not available on this build, so there is nothing to rank.'
        : 'Nothing survived retrieval and hard filtering for this intent. Submitting would create a new event.',
    ));
    return;
  }

  // No weights means no weighted track. Equal segments would be a fabrication.
  const w = hasWeights(weights) ? weights : null;
  const cards = ranked.map((r, i) => card(r, i, w, threshold, ctx));
  fill(root, cards);
  stagger(cards, 42);
  // Widths start at 0 so the fill animates in on the next frame.
  requestAnimationFrame(() => {
    for (const el of root.querySelectorAll('.track-fill')) el.style.width = `${el.dataset.pct}%`;
  });
}

function card(r, index, w, threshold, ctx) {
  const above = r.aboveThreshold === true;
  const breakdown = r.breakdown ?? {};

  const track = w === null ? null : h('div', { class: 'track-wrap' },
    h('div', { class: 'track' }, DIMS.map((dim) => h('div', {
      class: 'track-seg',
      style: { 'flex-grow': String(w[dim] ?? 0) },
      title: `${dim} ${score(breakdown[dim])} × weight ${score(w[dim])}`,
    }, h('i', { class: 'track-fill', dataset: { pct: String(clamp01(breakdown[dim]) * 100) } })))),
    typeof threshold === 'number'
      ? h('div', { class: 'track-threshold', style: { left: `${threshold * 100}%` }, 'data-label': `threshold ${score(threshold)}` })
      : null,
  );

  // With no published weights there is nothing to multiply by, so the ×weight
  // column is omitted rather than filled with a plausible-looking number.
  const dims = h('div', { class: 'dims' }, DIMS.map((dim) => h('div', { class: 'dim' },
    h('div', { class: 'dim-name', text: dim }),
    h('div', { class: 'dim-row' },
      h('span', { class: 'dim-val', text: score(breakdown[dim]) }),
      w === null ? null : h('span', { class: 'dim-w', text: `×${score(w[dim])}` }),
    ),
  )));

  const meta = [];
  if (r.locationId) meta.push(ctx.locationName(r.locationId));
  const when = timeRange(r.startTime, r.endTime);
  if (when) meta.push(when);
  if (typeof r.participantCount === 'number' && typeof r.capacity === 'number') {
    meta.push(`${r.participantCount}/${r.capacity} joined`);
  }

  return h('article', {
    class: `card${above ? ' is-above' : ''}${index === 0 ? ' is-top' : ''}`,
  },
    h('div', { class: 'card-head' },
      h('div', { class: 'card-rank', text: `#${index + 1}` }),
      h('div', { class: 'card-id' },
        h('h3', { class: 'card-title', text: titleize(r.activityId ?? 'Event') }),
        h('div', { class: 'card-meta' }, joinWithSeps(meta)),
      ),
      h('div', { class: 'card-score' },
        h('div', { class: 'v', text: score(r.score) }),
        h('div', { class: 'k', text: 'score' }),
      ),
    ),
    h('div', { class: 'card-flags' },
      h('span', { class: `badge${above ? ' badge-good' : ''}`, text: above ? 'clears threshold' : 'below threshold' }),
      h('span', { class: 'badge badge-mono', text: shortId(r.eventId) }),
      w === null ? h('span', { class: 'badge', title: 'This endpoint does not publish the scoring weights', text: 'weights not published' }) : null,
    ),
    track,
    dims,
  );
}

function joinWithSeps(parts) {
  const out = [];
  parts.forEach((p, i) => {
    if (i > 0) out.push(h('span', { class: 'sep', text: '·' }));
    out.push(h('span', { text: p }));
  });
  return out;
}

function clamp01(n) {
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

/** True only when the server actually published a weight for every dimension. */
function hasWeights(weights) {
  return weights != null && DIMS.every((d) => typeof weights[d] === 'number' && Number.isFinite(weights[d]));
}
