/** Current repository state, so joins are visible the instant they happen. */
import { h, fill } from '../lib/dom.js';
import { titleize, timeRange, initials, userStyle } from '../lib/format.js';
import { stagger } from '../lib/anim.js';
import { shortId } from './pipeline.js';

export function renderEvents(root, countEl, events, { userId, locationName }) {
  countEl.textContent = String(events.length);

  if (events.length === 0) {
    fill(root, h('li', { class: 'awaiting', text: 'No events yet. The first submitted intent creates one.' }));
    return;
  }

  const sorted = [...events].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const rows = sorted.map((e) => {
    const people = Array.isArray(e.participantIds) ? e.participantIds : [];
    const mine = people.includes(userId) || e.creatorId === userId;
    const empties = Math.max(0, Math.min(6, (e.capacity ?? 0) - people.length));

    return h('li', { class: `event${mine ? ' is-mine' : ''}` },
      h('div', { class: 'event-top' },
        h('span', { class: 'event-title', text: titleize(e.activityId) }),
        h('span', { class: 'event-cap', text: `${e.participantCount}/${e.capacity}` }),
      ),
      h('div', { class: 'event-meta', text: `${locationName(e.locationId)} · ${timeRange(e.startTime, e.endTime)}` }),
      h('div', { class: 'event-people' },
        people.map((p) => h('span', {
          class: 'avatar', style: userStyle(p), title: p, text: initials(p),
        })),
        Array.from({ length: empties }, () => h('span', { class: 'slot' })),
        h('span', { class: 'event-status', text: `${e.status} · ${shortId(e.id)}` }),
      ),
    );
  });

  fill(root, rows);
  stagger(rows, 26);
}
