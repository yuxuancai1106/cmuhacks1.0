import type { Clock } from '../core/types.js';

/** Real wall-clock time. Use this in production wiring. */
export function systemClock(): Clock {
  return { now: () => new Date() };
}

/** Deterministic, manually-advanceable clock for tests. */
export function fixedClock(at: Date): Clock & { set(d: Date): void; advance(ms: number): void } {
  let current = new Date(at.getTime());
  return {
    now(): Date {
      // Return a copy so callers cannot mutate our internal state through it.
      return new Date(current.getTime());
    },
    set(d: Date): void {
      current = new Date(d.getTime());
    },
    advance(ms: number): void {
      current = new Date(current.getTime() + ms);
    },
  };
}
