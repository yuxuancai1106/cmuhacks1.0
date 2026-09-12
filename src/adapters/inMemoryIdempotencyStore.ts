/**
 * In-memory `IdempotencyStore`. Development/single-process implementation —
 * a production deployment needs a shared store (e.g. Redis) so retries
 * arriving at a different instance still see the original outcome.
 */
import type { Clock, IdempotencyStore, MatchOutcome, UserId } from '../core/types.js';

const DEFAULT_TTL_MS = 10 * 60 * 1000;
/** Bounds store size so a long-lived process cannot leak memory. */
const MAX_ENTRIES = 5000;

interface Entry {
  outcome: MatchOutcome;
  expiresAt: number;
}

/** Composite key: idempotency keys are only unique per-user, not globally. */
function composeKey(userId: UserId, key: string): string {
  return `${userId} ${key}`;
}

export function createInMemoryIdempotencyStore(opts?: {
  ttlMs?: number;
  clock?: Clock;
}): IdempotencyStore {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const clock: Clock = opts?.clock ?? { now: () => new Date() };
  const store = new Map<string, Entry>();

  function nowMs(): number {
    return clock.now().getTime();
  }

  function evictExpired(): void {
    const cutoff = nowMs();
    for (const [k, entry] of store) {
      if (entry.expiresAt <= cutoff) store.delete(k);
    }
  }

  return {
    async get(userId: UserId, key: string): Promise<MatchOutcome | undefined> {
      const composite = composeKey(userId, key);
      const entry = store.get(composite);
      if (!entry) return undefined;
      if (entry.expiresAt <= nowMs()) {
        store.delete(composite);
        return undefined;
      }
      return entry.outcome;
    },

    async set(userId: UserId, key: string, outcome: MatchOutcome): Promise<void> {
      const composite = composeKey(userId, key);
      if (!store.has(composite) && store.size >= MAX_ENTRIES) {
        evictExpired();
        if (store.size >= MAX_ENTRIES) {
          // Still full after clearing expired entries: drop the oldest
          // (first-inserted) entry to bound memory.
          const oldestKey = store.keys().next().value;
          if (oldestKey !== undefined) store.delete(oldestKey);
        }
      }
      store.set(composite, { outcome, expiresAt: nowMs() + ttlMs });
    },
  };
}
