import { describe, it, expect } from 'vitest';
import { hardFilter, type HardFilterDeps } from '../../src/retrieval/hardFilters.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { AlgorithmConfig } from '../../src/config/types.js';
import { makeEvent, makeIntent, makeLocationService, makeTaxonomyIndex, NOW } from '../../tests/support/factories.js';

const deps: HardFilterDeps = {
  taxonomy: makeTaxonomyIndex(),
  locations: makeLocationService(),
  config: DEFAULT_CONFIG,
};

function rejectionFor(eventId: string, rejected: Array<{ eventId: string; reason: string }>) {
  return rejected.find((r) => r.eventId === eventId)?.reason;
}

describe('hardFilter — kept', () => {
  it('keeps an event that satisfies every hard filter', () => {
    const intent = makeIntent();
    const event = makeEvent();
    const { kept, rejected } = hardFilter({ intent, events: [event], deps, now: NOW });
    expect(kept.map((e) => e.id)).toEqual([event.id]);
    expect(rejected).toEqual([]);
  });
});

describe('hardFilter — expired-event filtering', () => {
  it('drops an event whose expiresAt is at or before now', () => {
    const intent = makeIntent();
    const expired = makeEvent({ id: 'expired', expiresAt: NOW });
    const { kept, rejected } = hardFilter({ intent, events: [expired], deps, now: NOW });
    expect(kept).toEqual([]);
    expect(rejectionFor('expired', rejected)).toBe('EXPIRED');
  });

  it('drops an event whose expiresAt is in the past', () => {
    const intent = makeIntent();
    const expired = makeEvent({ id: 'expired', expiresAt: new Date(NOW.getTime() - 1000) });
    const { rejected } = hardFilter({ intent, events: [expired], deps, now: NOW });
    expect(rejectionFor('expired', rejected)).toBe('EXPIRED');
  });
});

describe('hardFilter — capacity filtering', () => {
  it('drops a full event', () => {
    const intent = makeIntent();
    const full = makeEvent({ id: 'full', capacity: 4, participantCount: 4 });
    const { kept, rejected } = hardFilter({ intent, events: [full], deps, now: NOW });
    expect(kept).toEqual([]);
    expect(rejectionFor('full', rejected)).toBe('FULL');
  });

  it('keeps an event with room left', () => {
    const intent = makeIntent();
    const hasRoom = makeEvent({ id: 'has-room', capacity: 4, participantCount: 3 });
    const { kept } = hardFilter({ intent, events: [hasRoom], deps, now: NOW });
    expect(kept.map((e) => e.id)).toEqual(['has-room']);
  });
});

describe('hardFilter — status', () => {
  it('drops an event that is not OPEN', () => {
    const intent = makeIntent();
    const matched = makeEvent({ id: 'matched', status: 'MATCHED' });
    const { rejected } = hardFilter({ intent, events: [matched], deps, now: NOW });
    expect(rejectionFor('matched', rejected)).toBe('NOT_OPEN');
  });
});

describe('hardFilter — participation', () => {
  it('drops an event the user already participates in', () => {
    const intent = makeIntent();
    const event = makeEvent({ id: 'joined', participantIds: ['user-1', 'user-creator'] });
    const { rejected } = hardFilter({ intent, events: [event], deps, now: NOW, userId: 'user-1' });
    expect(rejectionFor('joined', rejected)).toBe('ALREADY_PARTICIPANT');
  });

  it("drops the requesting user's own event", () => {
    const intent = makeIntent();
    const event = makeEvent({ id: 'own', creatorId: 'user-1' });
    const { rejected } = hardFilter({ intent, events: [event], deps, now: NOW, userId: 'user-1' });
    expect(rejectionFor('own', rejected)).toBe('OWN_EVENT');
  });

  it('does not apply participation checks when no userId is supplied', () => {
    const intent = makeIntent();
    const event = makeEvent({ id: 'anon-ok', creatorId: 'user-1', participantIds: ['user-1'] });
    const { kept } = hardFilter({ intent, events: [event], deps, now: NOW });
    expect(kept.map((e) => e.id)).toEqual(['anon-ok']);
  });
});

describe('hardFilter — time incompatibility', () => {
  it('drops an event that has already ended, even if its matching window has not expired', () => {
    const intent = makeIntent({ startTime: undefined, endTime: undefined });
    const ended = makeEvent({
      id: 'ended',
      startTime: new Date(NOW.getTime() - 120 * 60_000),
      endTime: new Date(NOW.getTime() - 10 * 60_000),
      expiresAt: new Date(NOW.getTime() + 60 * 60_000),
    });
    const { rejected } = hardFilter({ intent, events: [ended], deps, now: NOW });
    expect(rejectionFor('ended', rejected)).toBe('TIME_INCOMPATIBLE');
  });

  it('drops an event whose time score falls below the configured threshold', () => {
    const strict: AlgorithmConfig = { ...DEFAULT_CONFIG, time: { ...DEFAULT_CONFIG.time, minAcceptable: 0.9 } };
    const strictDeps: HardFilterDeps = { ...deps, config: strict };
    const intent = makeIntent({ startTime: NOW, endTime: new Date(NOW.getTime() + 60 * 60_000) });
    // 3 hours off -- a real mismatch that the default minAcceptable (0.05) would let through.
    const farOff = makeEvent({
      id: 'far-off-time',
      startTime: new Date(NOW.getTime() + 180 * 60_000),
      endTime: new Date(NOW.getTime() + 240 * 60_000),
    });
    const { rejected } = hardFilter({ intent, events: [farOff], deps: strictDeps, now: NOW });
    expect(rejectionFor('far-off-time', rejected)).toBe('TIME_INCOMPATIBLE');
  });
});

describe('hardFilter — location incompatibility', () => {
  it('drops an event whose location score falls below the configured threshold', () => {
    const strict: AlgorithmConfig = {
      ...DEFAULT_CONFIG,
      location: { ...DEFAULT_CONFIG.location, minAcceptable: 0.1 },
    };
    const strictDeps: HardFilterDeps = { ...deps, config: strict };
    const intent = makeIntent({ locationIds: ['loc-a'] });
    const farAway = makeEvent({ id: 'far-away', locationId: 'loc-e' }); // different campus, far
    const { rejected } = hardFilter({ intent, events: [farAway], deps: strictDeps, now: NOW });
    expect(rejectionFor('far-away', rejected)).toBe('LOCATION_INCOMPATIBLE');
  });
});

describe('hardFilter — activity incompatibility', () => {
  it('drops an event whose activity has zero similarity to every intent activity', () => {
    const intent = makeIntent({ activityIds: ['painting'], categoryIds: [] });
    const event = makeEvent({ id: 'unrelated-activity', activityId: 'treadmill', categoryId: 'fitness' });
    const { rejected } = hardFilter({ intent, events: [event], deps, now: NOW });
    expect(rejectionFor('unrelated-activity', rejected)).toBe('ACTIVITY_INCOMPATIBLE');
  });

  it('does not reject on activity grounds when the intent names no activities', () => {
    const intent = makeIntent({ activityIds: [], categoryIds: [] });
    const event = makeEvent({ id: 'no-activity-constraint', activityId: 'painting', categoryId: 'art' });
    const { kept } = hardFilter({ intent, events: [event], deps, now: NOW });
    expect(kept.map((e) => e.id)).toEqual(['no-activity-constraint']);
  });
});
