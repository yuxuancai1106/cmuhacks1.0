import { describe, it, expect } from 'vitest';
import { createMemoryCache, createNullCache } from '../../src/cache/memory.js';
import { fixedClock } from '../../src/adapters/clock.js';
import { NOW } from '../../tests/support/factories.js';

describe('createMemoryCache — TTL expiry', () => {
  it('returns a stored value before it expires', async () => {
    const clock = fixedClock(NOW);
    const cache = createMemoryCache({ clock });
    await cache.set('key', 'value', 1000);
    await expect(cache.get('key')).resolves.toBe('value');
  });

  it('returns undefined once the TTL has elapsed', async () => {
    const clock = fixedClock(NOW);
    const cache = createMemoryCache({ clock });
    await cache.set('key', 'value', 1000);
    clock.advance(1001);
    await expect(cache.get('key')).resolves.toBeUndefined();
  });

  it('treats an entry at exactly its expiry instant as expired', async () => {
    const clock = fixedClock(NOW);
    const cache = createMemoryCache({ clock });
    await cache.set('key', 'value', 1000);
    clock.advance(1000);
    await expect(cache.get('key')).resolves.toBeUndefined();
  });

  it('delete removes a value immediately', async () => {
    const clock = fixedClock(NOW);
    const cache = createMemoryCache({ clock });
    await cache.set('key', 'value', 10_000);
    await cache.delete('key');
    await expect(cache.get('key')).resolves.toBeUndefined();
  });
});

describe('createMemoryCache — bounded eviction', () => {
  it('evicts the least-recently-used entry once at capacity', async () => {
    const clock = fixedClock(NOW);
    const cache = createMemoryCache({ clock, maxEntries: 2 });

    await cache.set('a', 1, 10_000);
    await cache.set('b', 2, 10_000);
    await cache.set('c', 3, 10_000); // over capacity: should evict 'a' (oldest, untouched)

    await expect(cache.get('a')).resolves.toBeUndefined();
    await expect(cache.get('b')).resolves.toBe(2);
    await expect(cache.get('c')).resolves.toBe(3);
  });

  it('reading an entry marks it recently-used, protecting it from the next eviction', async () => {
    const clock = fixedClock(NOW);
    const cache = createMemoryCache({ clock, maxEntries: 2 });

    await cache.set('a', 1, 10_000);
    await cache.set('b', 2, 10_000);
    await cache.get('a'); // touch 'a' -- 'b' is now the least-recently-used
    await cache.set('c', 3, 10_000);

    await expect(cache.get('a')).resolves.toBe(1);
    await expect(cache.get('b')).resolves.toBeUndefined();
    await expect(cache.get('c')).resolves.toBe(3);
  });

  it('never grows the store past maxEntries', async () => {
    const clock = fixedClock(NOW);
    const cache = createMemoryCache({ clock, maxEntries: 3 });
    for (let i = 0; i < 10; i++) {
      await cache.set(`key-${i}`, i, 10_000);
    }
    // Only the last 3 keys should still be resolvable.
    let present = 0;
    for (let i = 0; i < 10; i++) {
      if ((await cache.get(`key-${i}`)) !== undefined) present++;
    }
    expect(present).toBe(3);
  });
});

describe('createNullCache', () => {
  it('never returns a value that was set', async () => {
    const cache = createNullCache();
    await cache.set('key', 'value', 10_000);
    await expect(cache.get('key')).resolves.toBeUndefined();
  });

  it('delete on a null cache does not throw', async () => {
    const cache = createNullCache();
    await expect(cache.delete('key')).resolves.toBeUndefined();
  });
});
