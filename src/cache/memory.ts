/**
 * *** DEVELOPMENT IMPLEMENTATION ONLY ***
 *
 * `createMemoryCache` backs `CacheService` with a plain `Map` living in this
 * process's heap. It is fine for local development and tests, but it does
 * NOT survive restarts, is NOT shared across processes, and cannot back a
 * horizontally-scaled deployment — every instance would cache independently
 * and disagree. `CacheService` exists as a port specifically so this can be
 * swapped for Redis (or any shared cache) in production without the matching
 * algorithm, which only ever depends on the `CacheService` interface, having
 * to change at all.
 */
import type { CacheEntry, CacheService, Clock } from '../core/types.js';

const DEFAULT_MAX_ENTRIES = 5000;

export function createMemoryCache(opts?: { maxEntries?: number; clock?: Clock }): CacheService {
  const maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const clock: Clock = opts?.clock ?? { now: () => new Date() };
  const store = new Map<string, CacheEntry<unknown>>();

  function nowMs(): number {
    return clock.now().getTime();
  }

  /** Re-insertion moves `key` to the end of Map iteration order, which we use as the LRU queue. */
  function markRecentlyUsed(key: string, entry: CacheEntry<unknown>): void {
    store.delete(key);
    store.set(key, entry);
  }

  function evictOneIfAtCapacity(key: string): void {
    if (store.has(key) || store.size < maxEntries) return;
    // Map iteration order is insertion order, so the first key is the
    // least-recently-used one (see markRecentlyUsed).
    const oldestKey = store.keys().next().value;
    if (oldestKey !== undefined) store.delete(oldestKey);
  }

  return {
    async get<T>(key: string): Promise<T | undefined> {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= nowMs()) {
        store.delete(key);
        return undefined;
      }
      markRecentlyUsed(key, entry);
      return entry.value as T;
    },

    async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
      evictOneIfAtCapacity(key);
      markRecentlyUsed(key, { value, expiresAt: nowMs() + ttlMs });
    },

    async delete(key: string): Promise<void> {
      store.delete(key);
    },
  };
}

/** Cache that never stores anything — for tests that must prove behaviour without caching. */
export function createNullCache(): CacheService {
  return {
    async get<T>(): Promise<T | undefined> {
      return undefined;
    },
    async set(): Promise<void> {
      // intentionally a no-op
    },
    async delete(): Promise<void> {
      // intentionally a no-op
    },
  };
}
