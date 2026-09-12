/**
 * The hero: INTENT -> INDEXED QUERY -> HARD FILTER -> RANKED -> DECISION.
 *
 * The two elimination stages are deliberately drawn as different mechanisms,
 * because they are: stage 1 is cheap bulk elimination pushed into the indexed
 * query (status / expiry / capacity / activity / window), stage 2 is nuanced
 * elimination in application code (own event, already a participant, time and
 * location compatibility). Their reason enums are different and are never
 * merged.
 *
 * Each stage's headline figure is what *survived* it, so the five figures read
 * left to right as the funnel itself. Every one of them comes from
 * `POST /api/explain`.
 */
import { h, fill, clear } from '../lib/dom.js';
import { titleize, humanizeEnum, score, integer } from '../lib/format.js';
import { tweenNumber, stagger, pulse } from '../lib/anim.js';

const STAGES = [
  { key: 'intent', label: 'Intent' },
  { key: 'query', label: 'Indexed query', where: 'database' },
  { key: 'filter', label: 'Hard filter', where: 'application' },
  { key: 'ranked', label: 'Ranked' },
  { key: 'decision', label: 'Decision' },
];

const DECISION_WORD = {
  WOULD_JOIN: 'Would join',
  WOULD_CREATE: 'Would create',
  REJECTED: 'No match',
};

/** Which of the three meanings the single accent should take. */
export function outcomeKey(kind) {
  if (kind === 'WOULD_JOIN' || kind === 'MATCHED') return 'join';
  if (kind === 'WOULD_CREATE' || kind === 'PENDING') return 'create';
  if (kind === 'REJECTED') return 'reject';
  return 'idle';
}

let built = false;
const nodes = {};

function build(root) {
  clear(root);
  STAGES.forEach((stage, i) => {
    const figure = h('div', { class: 'stage-figure' });
    const detail = h('div', { class: 'stage-detail' });
    const badges = h('div', { class: 'badges' });
    const li = h('li', { class: `stage stage-${stage.key}` },
      h('div', { class: 'stage-head' },
        h('span', { class: 'stage-index', text: String(i + 1).padStart(2, '0') }),
        stage.where ? h('span', { class: 'stage-where', dataset: { where: stage.where }, text: stage.where }) : null,
      ),
      h('div', { class: 'stage-label', text: stage.label }),
      figure, detail, badges,
    );
    nodes[stage.key] = { li, figure, detail, badges };
    root.appendChild(li);
  });
  built = true;
}

function setFigure(stage, value, { word = false, tween = false } = {}) {
  const { figure } = nodes[stage];
  figure.classList.toggle('is-word', word);
  if (tween && typeof value === 'number') {
    tweenNumber(figure, value, (v) => integer(v));
  } else {
    figure.dataset.value = '';
    fill(figure, value);
  }
}

function badge(text, tone) {
  return h('span', { class: `badge${tone ? ` badge-${tone}` : ''}`, text });
}

const SEMANTIC_TONE = { DETERMINISTIC: 'good', CACHE: 'good', LLM: 'warn', FALLBACK: 'warn', NONE: null };

export function renderPipeline(root, { explain, degraded, ctx }) {
  if (!built) build(root);
  pulse(root, 'is-flowing');

  if (!explain) {
    for (const { key } of STAGES) {
      nodes[key].li.classList.add('is-empty');
      setFigure(key, '—');
      fill(nodes[key].detail);
      clear(nodes[key].badges);
    }
    fill(nodes.intent.detail, degraded
      ? 'Pipeline inspection is unavailable on this build of the server.'
      : 'Pick an activity, or type what you want to do.');
    return 'idle';
  }

  const { normalized = {}, semantic = {}, stages = {}, decision = {}, weights = {} } = explain;
  const ranked = Array.isArray(stages.ranked) ? stages.ranked : [];
  const rejected = Array.isArray(stages.rejected) ? stages.rejected : [];
  const excluded = Array.isArray(stages.excludedByQuery) ? stages.excludedByQuery : [];
  const hasTotal = typeof stages.total === 'number';
  const activityIds = Array.isArray(normalized.activityIds) ? normalized.activityIds : [];
  const resolved = activityIds.length > 0;

  for (const { key } of STAGES) nodes[key].li.classList.toggle('is-empty', !resolved);

  // --- 1. intent ------------------------------------------------------------
  setFigure('intent', resolved ? activityIds.map(titleize).join(', ') : 'Unresolved', { word: true });
  const tagCount = Array.isArray(normalized.tags) ? normalized.tags.length : 0;
  fill(nodes.intent.detail,
    resolved
      ? [(normalized.categoryIds ?? []).map(titleize).join(', ') || 'no category',
         ' · ', h('b', { text: String(tagCount) }), ' tags',
         (normalized.locationIds ?? []).length > 0
           ? [' · ', ctx.locationName(normalized.locationIds[0])] : ' · any location']
      : 'Nothing in the intent maps to the controlled vocabulary.');

  const intentBadges = [];
  if (semantic.source && semantic.source !== 'NONE') {
    intentBadges.push(badge(semantic.source, SEMANTIC_TONE[semantic.source] ?? null));
  }
  // Only worth a badge when the model-free lookup actually moved the term.
  if (semantic.matchedTerm && semantic.canonicalActivity
      && semantic.matchedTerm !== semantic.canonicalActivity) {
    const b = badge(`${semantic.matchedTerm} → ${semantic.canonicalActivity}`, SEMANTIC_TONE[semantic.source] ?? null);
    b.classList.add('badge-mono');
    intentBadges.push(b);
  }
  if (normalized.resolvedFrom) {
    const b = badge(normalized.resolvedFrom);
    b.classList.add('badge-mono');
    b.title = 'How the time window was resolved';
    intentBadges.push(b);
  }
  fill(nodes.intent.badges, intentBadges);

  // --- 2. indexed query (database-side bulk elimination) --------------------
  setFigure('query', stages.retrieved ?? 0, { tween: true });
  fill(nodes.query.detail, hasTotal
    ? ['of ', h('b', { text: integer(stages.total) }), ' in the store · ',
       h('b', { text: String(excluded.length) }), ' never retrieved']
    : 'open events the index returned');
  fill(nodes.query.badges, topReasons(excluded, 2));

  // --- 3. hard filter (application-side nuanced elimination) ---------------
  setFigure('filter', stages.kept ?? 0, { tween: true });
  fill(nodes.filter.detail, [h('b', { text: String(rejected.length) }), ' dropped after retrieval']);
  fill(nodes.filter.badges, topReasons(rejected, 2));

  // --- 4. ranked ------------------------------------------------------------
  const above = ranked.filter((r) => r.aboveThreshold).length;
  setFigure('ranked', ranked.length, { tween: true });
  fill(nodes.ranked.detail, ranked.length > 0
    ? ['top ', h('b', { text: score(ranked[0].score) }), ' · ', h('b', { text: String(above) }), ' cleared']
    : 'nothing survived to scoring');
  clear(nodes.ranked.badges);

  // --- 5. decision ----------------------------------------------------------
  const kind = decision.kind ?? 'REJECTED';
  setFigure('decision', DECISION_WORD[kind] ?? humanizeEnum(kind), { word: true });
  const threshold = typeof decision.threshold === 'number' ? decision.threshold : ctx.threshold;
  fill(nodes.decision.detail, kind === 'WOULD_JOIN'
    ? [h('b', { text: score(decision.score) }), ' ≥ ', score(threshold), ' threshold']
    : kind === 'WOULD_CREATE'
      ? (typeof decision.score === 'number'
          ? [h('b', { text: score(decision.score) }), ' < ', score(threshold), ' — a new event']
          : 'no candidate cleared the threshold — a new event')
      : 'nothing resolvable to retrieve against');
  fill(nodes.decision.badges, badge('prediction'));

  return { key: outcomeKey(kind), weights, ranked, rejected, excluded, threshold, stages };
}

export function countReasons(list) {
  const counts = new Map();
  for (const r of list) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
  return new Map([...counts.entries()].sort((a, b) => b[1] - a[1]));
}

function topReasons(list, limit) {
  const entries = [...countReasons(list).entries()];
  const shown = entries.slice(0, limit).map(([r, n]) => {
    const b = badge(`${r} ×${n}`, 'bad');
    b.classList.add('badge-mono');
    b.title = `${n} eliminated: ${r}`;
    return b;
  });
  if (entries.length > limit) {
    const rest = entries.slice(limit).reduce((sum, [, n]) => sum + n, 0);
    shown.push(badge(`+${entries.length - limit} more`, null));
  }
  return shown;
}

/* -------------------------------------------------------------------------- */
/* Funnel proportions — the whole store, spent across both eliminations        */
/* -------------------------------------------------------------------------- */

const STRIPES = 'repeating-linear-gradient(135deg, color-mix(in srgb, var(--ink-3) 40%, transparent) 0 3px, transparent 3px 6px)';

export function renderFunnel(wrap, track, legend, { stages, ranked, excluded }) {
  const total = typeof stages.total === 'number' ? stages.total : (stages.retrieved ?? 0);
  if (!total) { wrap.hidden = true; return; }
  wrap.hidden = false;

  const above = ranked.filter((r) => r.aboveThreshold).length;
  const below = Math.max(0, ranked.length - above);
  const unranked = Math.max(0, (stages.kept ?? 0) - ranked.length);

  const segs = [
    { n: excluded.length, label: 'excluded by the indexed query', stripe: true, color: 'color-mix(in srgb, var(--ink-3) 18%, transparent)' },
    { n: (stages.rejected ?? []).length, label: 'dropped by hard filters', color: 'color-mix(in srgb, var(--red) 55%, transparent)' },
    { n: unranked, label: 'kept, not ranked', color: 'color-mix(in srgb, var(--ink-3) 30%, transparent)' },
    { n: below, label: 'scored below threshold', color: 'color-mix(in srgb, var(--ink-3) 60%, transparent)' },
    { n: above, label: 'cleared the threshold', color: 'var(--green)' },
  ].filter((s) => s.n > 0);

  fill(track, segs.map((s) => h('div', {
    class: 'funnel-seg',
    style: { 'flex-grow': String(s.n), background: s.stripe ? `${STRIPES}, ${s.color}` : s.color },
    title: `${s.n} ${s.label}`,
  })));

  fill(legend, [
    h('span', { class: 'funnel-total' }, h('b', { text: String(total) }), ' events in the store'),
    ...segs.map((s) => h('span', { class: 'funnel-key' },
      h('i', { style: { background: s.stripe ? `${STRIPES}, ${s.color}` : s.color } }),
      `${s.n} ${s.label}`)),
  ]);
}

/* -------------------------------------------------------------------------- */
/* Rejection ledger — one group per mechanism, never merged                    */
/* -------------------------------------------------------------------------- */

const LEDGERS = [
  {
    id: 'query',
    stage: 'Stage 1 · indexed query',
    note: 'Eliminated inside the database query, before any application code ran.',
    verb: 'never retrieved',
  },
  {
    id: 'filter',
    stage: 'Stage 2 · hard filter',
    note: 'Retrieved, then eliminated in application code. Absolute — no score can rescue these.',
    verb: 'dropped',
  },
];

export function renderDrops(section, container, { excluded, rejected }, state) {
  const groups = [{ ...LEDGERS[0], items: excluded }, { ...LEDGERS[1], items: rejected }]
    .filter((g) => g.items.length > 0);

  if (groups.length === 0) { section.hidden = true; return; }
  section.hidden = false;
  fill(container, groups.map((g) => ledger(g, state, () => renderDrops(section, container, { excluded, rejected }, state))));
}

function ledger(group, state, rerender) {
  const counts = countReasons(group.items);
  const active = state.dropFilter[group.id];
  if (active && !counts.has(active)) state.dropFilter[group.id] = null;

  const pills = [...counts.entries()].map(([reason, n]) => h('button', {
    type: 'button', class: 'drop-pill', 'aria-pressed': String(state.dropFilter[group.id] === reason),
    on: {
      click: () => {
        state.dropFilter[group.id] = state.dropFilter[group.id] === reason ? null : reason;
        rerender();
      },
    },
  }, reason, h('span', { class: 'n', text: String(n) })));

  const visible = state.dropFilter[group.id]
    ? group.items.filter((r) => r.reason === state.dropFilter[group.id])
    : group.items;

  const rows = visible.slice(0, 12).map((r) => h('li', { class: 'drop-row' },
    h('span', { class: 'drop-id', text: shortId(r.eventId) }),
    h('span', { text: titleize(r.activityId ?? '') }),
    h('span', { class: 'drop-reason', text: r.reason }),
  ));
  if (visible.length > rows.length) {
    rows.push(h('li', { class: 'drop-row drop-more', text: `+ ${visible.length - rows.length} more` }));
  }
  stagger(rows, 16);

  return h('div', { class: `ledger ledger-${group.id}` },
    h('div', { class: 'ledger-head' },
      h('div', { class: 'ledger-bar' },
        h('h3', { class: 'ledger-title' }, h('span', { class: 'ledger-stage', text: group.stage })),
        h('p', { class: 'ledger-count' }, h('b', { text: String(group.items.length) }), ` ${group.verb}`),
      ),
      h('p', { class: 'ledger-note', text: group.note }),
    ),
    h('div', { class: 'drop-pills' }, pills),
    h('ul', { class: 'drop-list' }, rows),
  );
}

export function shortId(id) {
  const s = String(id ?? '');
  return s.length > 18 ? `${s.slice(0, 13)}…${s.slice(-4)}` : s;
}
