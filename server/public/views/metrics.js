/**
 * Live metrics. The headline is the one number the design is arguing about:
 * LLM calls per match request.
 */
import { h, fill } from '../lib/dom.js';
import { tweenNumber, prefersReducedMotion } from '../lib/anim.js';
import { score, integer } from '../lib/format.js';

const TILES = [
  { key: 'llmCallRatio', label: 'LLM calls / match request', hero: true, wide: true, fmt: (v) => score(v, 2) },
  { key: 'llmCalls', label: 'LLM calls total', fmt: integer },
  { key: 'matchRequests', label: 'Match requests', fmt: integer },
  { key: 'matched', label: 'Matched', fmt: integer },
  { key: 'pending', label: 'Created', fmt: integer },
  { key: 'rejected', label: 'Rejected', fmt: integer },
  { key: 'joinConflicts', label: 'Join conflicts', fmt: integer },
  { key: 'semanticCacheHitRate', label: 'Semantic cache hit', fmt: (v) => score(v, 2) },
  { key: 'recommendationCacheHitRate', label: 'Rec. cache hit', fmt: (v) => score(v, 2) },
];

const cells = new Map();
let built = false;

export function renderMetrics(root, metrics, headlineValue, headlineWrap, modeEl) {
  if (!metrics) return;

  if (!built) {
    fill(root, TILES.map((t) => {
      const v = h('div', { class: 'metric-v', text: '—' });
      cells.set(t.key, v);
      return h('div', {
        class: `metric${t.hero ? ' is-hero' : ''}${t.wide ? ' is-wide' : ''}`,
        dataset: { key: t.key },
      }, v, h('div', { class: 'metric-k', text: t.label }));
    }));
    built = true;
  }

  for (const t of TILES) {
    const el = cells.get(t.key);
    const value = metrics[t.key];
    const previous = el.dataset.value;
    if (typeof value === 'number' && Number.isFinite(value)) {
      tweenNumber(el, value, t.fmt);
      if (previous !== undefined && previous !== '' && Number(previous) !== value && !prefersReducedMotion()) {
        const tile = el.parentElement;
        tile.classList.remove('just-changed');
        void tile.offsetWidth;
        tile.classList.add('just-changed');
      }
    } else {
      el.textContent = '—';
    }
  }

  const ratio = metrics.llmCallRatio;
  const hot = typeof ratio === 'number' && ratio > 0;
  tweenNumber(headlineValue, typeof ratio === 'number' ? ratio : NaN, (v) => score(v, 2));
  headlineWrap.classList.toggle('is-hot', hot);
  root.querySelector('.metric.is-hero')?.classList.toggle('is-hot', hot);

  fill(modeEl,
    h('span', { class: `llm-dot${metrics.llmLive ? ' is-live' : ''}` }),
    metrics.llmLive
      ? 'LLM configured — still only consulted for unknown words.'
      : 'No LLM configured. The deterministic tier is carrying the demo.');
}
