/**
 * Compose rail: identity, activity chips, free text, location, time, suggestions.
 *
 * The free-text readout is a *vocabulary lookup*, not a guess: the word lists it
 * checks against are exactly the ones `GET /api/vocabulary` publishes. The
 * authoritative answer — whether the term resolved deterministically, from
 * cache, or would need the model — is the `semantic.source` badge the pipeline
 * shows, straight from `/api/explain`.
 */
import { h, fill } from '../lib/dom.js';
import { titleize, initials, userStyle } from '../lib/format.js';

export const USERS = ['alice', 'bob', 'carol', 'dan'];

export function renderIdentity(root, current, onChange) {
  fill(root, USERS.flatMap((id) => {
    const input = h('input', {
      type: 'radio', name: 'identity', id: `who-${id}`, value: id, checked: id === current,
      on: { change: () => onChange(id) },
    });
    const label = h('label', { for: `who-${id}` },
      h('span', { class: 'avatar', style: userStyle(id), text: initials(id) }),
      h('span', { text: titleize(id) }),
    );
    return [input, label];
  }));
}

export function renderActivities(root, categories, selected, onToggle) {
  fill(root, categories.map((cat) => h('div', { class: 'act-group' },
    h('div', { class: 'act-group-name', text: cat.name }),
    h('div', { class: 'chips' }, cat.activities.map((a) => h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(selected.has(a.id)),
      title: `tags: ${a.tags.join(', ')}`,
      on: { click: () => onToggle(a.id) },
    }, titleize(a.id)))),
  )));
}

export function renderLocations(select, locations) {
  const current = select.value;
  fill(select,
    h('option', { value: '', text: 'Any location' }),
    locations.map((l) => h('option', { value: l.id, text: l.name })));
  select.value = current;
}

/** Lowercase, strip punctuation, collapse whitespace — mirrors `normalizeText`. */
export function tokensOf(text) {
  return text
    .toLowerCase()
    .replace(/[!?.,;:'"‘’“”]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t.length > 0);
}

export function renderTokens(root, text, vocab) {
  const tokens = tokensOf(text);
  if (tokens.length === 0) {
    fill(root, h('span', { class: 'tok-note', text: 'Known words resolve without a model call.' }));
    return;
  }

  const chips = [];
  let hits = 0;
  for (const token of tokens) {
    const known = vocab.activityIds.has(token) || vocab.synonyms.has(token);
    if (known) hits += 1;
    chips.push(h('span', { class: `tok ${known ? 'tok-hit' : 'tok-miss'}` },
      token,
      h('span', { class: 'tok-arrow', text: known ? '· in vocabulary' : '· unknown' })));
  }

  chips.push(h('span', {
    class: 'tok-note',
    text: hits > 0
      ? 'At least one word is in the controlled vocabulary — the deterministic tier can answer.'
      : 'No word is in the vocabulary. Only unresolvable text reaches the model.',
  }));
  fill(root, chips);
}

export function renderSuggestions(block, list, whoEl, suggestions, userId, onPick) {
  if (!suggestions || suggestions.length === 0) { block.hidden = true; return; }
  block.hidden = false;
  whoEl.textContent = titleize(userId);
  fill(list, suggestions.slice(0, 4).map((s) => h('button', {
    type: 'button', class: 'sug', on: { click: () => onPick(s.activityId) },
  },
    h('span', { class: 'sug-text' },
      h('span', { class: 'sug-name', text: titleize(s.activityId) }),
      h('span', { class: 'sug-why', text: (s.reason ?? []).join(' · ') || s.categoryId }),
    ),
    h('span', { class: 'sug-score', text: typeof s.score === 'number' ? s.score.toFixed(2) : '' }),
  )));
}
