/**
 * In-memory `Metrics` implementations.
 *
 * Numeric only, by design: this module must never accept or store raw user
 * text or profile data. `Metrics.increment`/`observe` are keyed by the fixed
 * `MetricName` union, and every value recorded is a `number` — there is no
 * way to attach a text label through this port, which is deliberate.
 */
import type { Metrics, MetricName } from '../core/types.js';

export interface ObservedStats {
  count: number;
  sum: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
}

export interface MetricsSnapshot {
  counters: Partial<Record<MetricName, number>>;
  observations: Partial<Record<MetricName, ObservedStats>>;
}

/** Bounds per-metric sample retention so a long-lived process cannot leak memory. */
const MAX_SAMPLES_PER_METRIC = 10_000;

function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const index = Math.min(
    sortedAscending.length - 1,
    Math.max(0, Math.ceil(p * sortedAscending.length) - 1),
  );
  return sortedAscending[index] ?? 0;
}

export function createInMemoryMetrics(): Metrics & {
  snapshot(): MetricsSnapshot;
  reset(): void;
} {
  let counters = new Map<MetricName, number>();
  let samples = new Map<MetricName, number[]>();

  function increment(name: MetricName, value = 1): void {
    counters.set(name, (counters.get(name) ?? 0) + value);
  }

  function observe(name: MetricName, value: number): void {
    const list = samples.get(name) ?? [];
    list.push(value);
    if (list.length > MAX_SAMPLES_PER_METRIC) list.shift();
    samples.set(name, list);
  }

  function snapshot(): MetricsSnapshot {
    const counterSnapshot: Partial<Record<MetricName, number>> = {};
    for (const [name, value] of counters) counterSnapshot[name] = value;

    const observationSnapshot: Partial<Record<MetricName, ObservedStats>> = {};
    for (const [name, values] of samples) {
      if (values.length === 0) continue;
      const sorted = [...values].sort((a, b) => a - b);
      const sum = sorted.reduce((acc, v) => acc + v, 0);
      observationSnapshot[name] = {
        count: sorted.length,
        sum,
        min: sorted[0] ?? 0,
        max: sorted[sorted.length - 1] ?? 0,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
      };
    }

    return { counters: counterSnapshot, observations: observationSnapshot };
  }

  function reset(): void {
    counters = new Map();
    samples = new Map();
  }

  return { increment, observe, snapshot, reset };
}

export function createNoopMetrics(): Metrics {
  return {
    increment(): void {
      // intentionally a no-op
    },
    observe(): void {
      // intentionally a no-op
    },
  };
}

/** Headline ratio from the spec: how often the LLM was invoked per match request. */
export function llmCallRatio(s: MetricsSnapshot): number {
  const requests = s.counters['match.requests'] ?? 0;
  if (requests === 0) return 0;
  const calls = s.counters['llm.calls'] ?? 0;
  return calls / requests;
}

function hitRate(hits: number, misses: number): number {
  const total = hits + misses;
  return total === 0 ? 0 : hits / total;
}

export function semanticCacheHitRate(s: MetricsSnapshot): number {
  return hitRate(s.counters['semantic.cache.hit'] ?? 0, s.counters['semantic.cache.miss'] ?? 0);
}

export function recommendationCacheHitRate(s: MetricsSnapshot): number {
  return hitRate(
    s.counters['recommendation.cache.hit'] ?? 0,
    s.counters['recommendation.cache.miss'] ?? 0,
  );
}
