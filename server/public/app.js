/**
 * FriendMatch demo — app shell.
 *
 * One rule runs through the whole file: nothing is displayed that the API did
 * not return. Where an endpoint is unavailable the UI says so and shows less,
 * rather than showing something plausible.
 */
import { $, fill, h } from './lib/dom.js';
import * as api from './lib/api.js';
import { toLocalInputValue } from './lib/format.js';
import { pulse } from './lib/anim.js';
import { renderPipeline, renderFunnel, renderDrops } from './views/pipeline.js';
import { renderCandidates } from './views/candidates.js';
import { renderOutcome } from './views/outcome.js';
import { renderMetrics } from './views/metrics.js';
import { renderEvents } from './views/events.js';
import {
  USERS, renderIdentity, renderActivities, renderLocations, renderTokens, renderSuggestions,
} from './views/compose.js';

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

const state = {
  userId: USERS[0],
  activityIds: new Set(),
  text: '',
  locationId: '',
  startTime: '',
  vocabulary: null,
  explain: null,
  explainMissing: false,
  fallbackRanked: null,
  outcomeRecord: null,
  metrics: null,
  events: [],
  suggestions: [],
  dropFilter: { query: null, filter: null },
  bootstrapped: false,
};

const vocabIndex = { activityIds: new Set(), synonyms: new Set(), locationNames: new Map(), threshold: 0.7 };

const ctx = {
  locationName: (id) => vocabIndex.locationNames.get(id) ?? (id ? String(id) : 'Any location'),
  get threshold() { return vocabIndex.threshold; },
};

/* -------------------------------------------------------------------------- */
/* Elements                                                                    */
/* -------------------------------------------------------------------------- */

const el = {
  form: $('#composeForm'),
  identity: $('#identityOptions'),
  activityGroups: $('#activityGroups'),
  textInput: $('#textInput'),
  tokenReadout: $('#tokenReadout'),
  locationSelect: $('#locationSelect'),
  startInput: $('#startInput'),
  suggestBlock: $('#suggestBlock'),
  suggestions: $('#suggestions'),
  sugWho: $('#sugWho'),
  submitBtn: $('#submitBtn'),
  resetBtn: $('#resetBtn'),
  pipeline: $('#stage-pipeline'),
  pipeSub: $('#pipeSub'),
  degraded: $('#degradedBanner'),
  funnel: $('#funnel'),
  funnelTrack: $('#funnelTrack'),
  funnelLegend: $('#funnelLegend'),
  drops: $('#drops'),
  dropGroups: $('#dropGroups'),
  rankedSub: $('#rankedSub'),
  cards: $('#candidateCards'),
  outcomePanel: $('#outcomePanel'),
  metrics: $('#metrics'),
  llmMode: $('#llmMode'),
  events: $('#events'),
  eventCount: $('#eventCount'),
  headline: $('#headline'),
  headlineValue: $('#headlineValue'),
  themeToggle: $('#themeToggle'),
};

/* -------------------------------------------------------------------------- */
/* Intent                                                                      */
/* -------------------------------------------------------------------------- */

function intentBody() {
  const body = { userId: state.userId };
  if (state.activityIds.size > 0) body.activityIds = [...state.activityIds];
  if (state.text.trim() !== '') body.text = state.text.trim();
  if (state.locationId !== '') body.locationIds = [state.locationId];
  if (state.startTime !== '') {
    const d = new Date(state.startTime);
    if (!Number.isNaN(d.getTime())) body.startTime = d.toISOString();
  }
  return body;
}

const hasIntent = () => state.activityIds.size > 0 || state.text.trim() !== '';

/* -------------------------------------------------------------------------- */
/* The prediction pass                                                         */
/* -------------------------------------------------------------------------- */

let inflight = null;
let timer = 0;

function schedule(delay = 140) {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => { void runExplain(); }, delay);
}

async function runExplain() {
  inflight?.abort();

  if (!hasIntent()) {
    state.explain = null;
    state.fallbackRanked = null;
    paintPrediction();
    return;
  }

  const controller = new AbortController();
  inflight = controller;

  try {
    if (!state.explainMissing) {
      state.explain = await api.explain(intentBody(), controller.signal);
      state.fallbackRanked = null;
      if (state.explain?.metrics) applyMetrics(state.explain.metrics);
    } else {
      await runFallback(controller.signal);
    }
  } catch (err) {
    if (err?.name === 'AbortError') return;
    if (err instanceof api.ApiError && err.missing && !state.explainMissing) {
      state.explainMissing = true;
      try { await runFallback(controller.signal); } catch (e) { if (e?.name !== 'AbortError') showError(e); }
    } else {
      showError(err);
      state.explain = null;
    }
  } finally {
    if (inflight === controller) inflight = null;
  }
  paintPrediction();
}

/** `/api/explain` is absent: fall back to the advisory list, and say so. */
async function runFallback(signal) {
  const result = await api.recommend(intentBody(), signal);
  state.explain = null;
  state.fallbackRanked = (result.recommendations ?? []).map((r) => ({
    eventId: r.eventId,
    activityId: r.event?.activityId,
    locationId: r.event?.locationId,
    participantCount: r.event?.participantCount,
    capacity: r.event?.capacity,
    startTime: r.event?.startTime,
    endTime: r.event?.endTime,
    score: r.score,
    aboveThreshold: r.score >= vocabIndex.threshold,
    breakdown: r.breakdown,
  }));
  if (result.metrics) applyMetrics(result.metrics);
}

function paintPrediction() {
  const degraded = state.explainMissing;
  el.degraded.hidden = !degraded;
  if (degraded) {
    fill(el.degraded,
      h('strong', { text: 'Pipeline inspector unavailable. ' }),
      'This server build does not expose ',
      h('code', { text: 'POST /api/explain' }),
      ', so retrieval and hard-filter counts cannot be shown. The candidates below come from ',
      h('code', { text: 'POST /api/recommend' }),
      ' — real scores, but no stage-by-stage breakdown and no configured weights.');
  }

  const result = renderPipeline(el.pipeline, { explain: state.explain, degraded, ctx });

  if (typeof result === 'string' || !state.explain) {
    setAccent(state.explainMissing && state.fallbackRanked?.length ? 'idle' : 'idle');
    el.funnel.hidden = true;
    el.drops.hidden = true;
    renderCandidates(el.cards, {
      ranked: state.fallbackRanked ?? [],
      weights: null,
      threshold: vocabIndex.threshold,
      ctx,
      degraded,
    });
    el.rankedSub.textContent = degraded
      ? 'Advisory scores from /api/recommend. Configured weights are not exposed by this endpoint, so the weighted track is omitted.'
      : 'Bar widths are the configured weights; fill is the dimension score. Total fill = the score.';
    return;
  }

  setAccent(result.key);
  renderFunnel(el.funnel, el.funnelTrack, el.funnelLegend, {
    stages: result.stages, ranked: result.ranked, excluded: result.excluded,
  });
  renderDrops(el.drops, el.dropGroups, { excluded: result.excluded, rejected: result.rejected }, state);
  renderCandidates(el.cards, {
    ranked: result.ranked,
    weights: result.weights,
    threshold: result.threshold,
    ctx,
    degraded: false,
  });
  el.rankedSub.textContent = 'Bar widths are the configured weights; fill is the dimension score. Total fill = the score.';
}

function setAccent(key) {
  document.documentElement.dataset.outcome = key;
}

function showError(err) {
  el.degraded.hidden = false;
  fill(el.degraded, h('strong', { text: 'Request failed. ' }), String(err?.message ?? err));
}

/**
 * Last-resort surface. A render bug should never leave the page looking like a
 * correct-but-stale answer — in a demo whose whole point is that its numbers are
 * real, silently frozen numbers are the worst failure mode. Anything that
 * escapes a handler gets said out loud.
 */
function installGlobalErrorSurface() {
  const report = (err) => {
    el.degraded.hidden = false;
    fill(el.degraded,
      h('strong', { text: 'Something broke while rendering. ' }),
      'The figures on screen may be stale — reload before trusting them. ',
      h('code', { text: String(err?.message ?? err) }));
  };
  window.addEventListener('error', (e) => report(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => report(e.reason));
}

/* -------------------------------------------------------------------------- */
/* The acting pass                                                             */
/* -------------------------------------------------------------------------- */

async function submit(event) {
  event.preventDefault();
  if (!hasIntent()) return;

  const prediction = state.explain?.decision ?? null;
  el.submitBtn.disabled = true;
  try {
    const result = await api.match(intentBody());
    state.outcomeRecord = { outcome: result.outcome, at: new Date().toISOString(), prediction };
    if (result.metrics) applyMetrics(result.metrics);
    renderOutcome(el.outcomePanel, state.outcomeRecord, ctx);
    pulse(el.outcomePanel.firstElementChild, 'enter');
    await Promise.all([refreshEvents(), refreshSuggestions()]);
    await runExplain();
  } catch (err) {
    showError(err);
  } finally {
    el.submitBtn.disabled = false;
  }
}

/* -------------------------------------------------------------------------- */
/* Refreshers                                                                  */
/* -------------------------------------------------------------------------- */

function applyMetrics(metrics) {
  state.metrics = metrics;
  renderMetrics(el.metrics, metrics, el.headlineValue, el.headline, el.llmMode);
}

async function refreshEvents() {
  try {
    const { events } = await api.getEvents();
    state.events = events ?? [];
  } catch { state.events = []; }
  renderEvents(el.events, el.eventCount, state.events, { userId: state.userId, locationName: ctx.locationName });
}

async function refreshMetrics() {
  try { applyMetrics(await api.getMetrics()); } catch { /* metrics are optional chrome */ }
}

async function refreshSuggestions() {
  try {
    const payload = await api.getSuggestions(state.userId);
    state.suggestions = payload.suggestions ?? [];
    if (payload.metrics) applyMetrics(payload.metrics);
  } catch { state.suggestions = []; }
  renderSuggestions(el.suggestBlock, el.suggestions, el.sugWho, state.suggestions, state.userId, (activityId) => {
    toggleActivity(activityId, true);
  });
}

/* -------------------------------------------------------------------------- */
/* Compose interactions                                                        */
/* -------------------------------------------------------------------------- */

function toggleActivity(id, forceOn = false) {
  if (state.activityIds.has(id) && !forceOn) state.activityIds.delete(id);
  else state.activityIds.add(id);
  paintActivities();
  schedule(0);
}

function paintActivities() {
  if (!state.vocabulary) return;
  renderActivities(el.activityGroups, state.vocabulary.categories, state.activityIds, (id) => toggleActivity(id));
}

function setIdentity(userId) {
  state.userId = userId;
  state.outcomeRecord = null;
  renderOutcome(el.outcomePanel, null, ctx);
  renderEvents(el.events, el.eventCount, state.events, { userId, locationName: ctx.locationName });
  void refreshSuggestions();
  schedule(0);
}

function wire() {
  el.form.addEventListener('submit', submit);

  el.textInput.addEventListener('input', () => {
    state.text = el.textInput.value;
    renderTokens(el.tokenReadout, state.text, vocabIndex);
    schedule(230);
  });

  el.locationSelect.addEventListener('change', () => {
    state.locationId = el.locationSelect.value;
    schedule(0);
  });

  el.startInput.addEventListener('change', () => {
    state.startTime = el.startInput.value;
    schedule(0);
  });

  for (const btn of document.querySelectorAll('[data-quick]')) {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.quick;
      if (kind === 'clear') { el.startInput.value = ''; }
      else {
        const d = new Date();
        if (kind === '+60') d.setMinutes(d.getMinutes() + 60);
        if (kind === 'tonight') { d.setHours(20, 0, 0, 0); }
        el.startInput.value = toLocalInputValue(d);
      }
      state.startTime = el.startInput.value;
      schedule(0);
    });
  }

  el.resetBtn.addEventListener('click', async () => {
    el.resetBtn.disabled = true;
    try {
      const payload = await api.reset();
      if (payload?.metrics) applyMetrics(payload.metrics);
      state.outcomeRecord = null;
      renderOutcome(el.outcomePanel, null, ctx);
      await Promise.all([refreshEvents(), refreshSuggestions()]);
      await runExplain();
    } catch (err) { showError(err); } finally { el.resetBtn.disabled = false; }
  });

  el.themeToggle.addEventListener('click', () => {
    const root = document.documentElement;
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const current = root.dataset.theme ?? (systemDark ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('fm.theme', next); } catch { /* storage unavailable */ }
  });
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                        */
/* -------------------------------------------------------------------------- */

async function boot() {
  renderIdentity(el.identity, state.userId, setIdentity);
  renderOutcome(el.outcomePanel, null, ctx);
  renderTokens(el.tokenReadout, '', vocabIndex);
  wire();

  try {
    const vocab = await api.getVocabulary();
    state.vocabulary = vocab;
    vocabIndex.threshold = typeof vocab.matchThreshold === 'number' ? vocab.matchThreshold : 0.7;
    for (const cat of vocab.categories ?? []) {
      for (const a of cat.activities ?? []) vocabIndex.activityIds.add(a.id);
    }
    for (const syn of vocab.synonyms ?? []) vocabIndex.synonyms.add(syn);
    for (const l of vocab.locations ?? []) vocabIndex.locationNames.set(l.id, l.name);

    paintActivities();
    renderLocations(el.locationSelect, vocab.locations ?? []);
    el.pipeSub.textContent = `Threshold ${vocabIndex.threshold.toFixed(2)} · every figure below is returned by POST /api/explain.`;
  } catch (err) {
    showError(err);
    fill(el.activityGroups, h('p', { class: 'rail-note', text: 'Vocabulary could not be loaded.' }));
  }

  await Promise.all([refreshMetrics(), refreshEvents(), refreshSuggestions()]);

  // Start on the API's own top suggestion for this user rather than an empty
  // screen — it is a real recommendation, not a fabricated default.
  if (!state.bootstrapped && state.suggestions.length > 0) {
    state.bootstrapped = true;
    state.activityIds.add(state.suggestions[0].activityId);
    paintActivities();
  }

  await runExplain();
}

installGlobalErrorSurface();
void boot();
