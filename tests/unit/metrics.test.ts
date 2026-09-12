import { describe, it, expect } from 'vitest';
import {
  createInMemoryMetrics,
  createNoopMetrics,
  llmCallRatio,
  recommendationCacheHitRate,
  semanticCacheHitRate,
  type MetricsSnapshot,
} from '../../src/observability/metrics.js';

describe('createInMemoryMetrics — counters', () => {
  it('defaults to incrementing by 1', () => {
    const metrics = createInMemoryMetrics();
    metrics.increment('match.requests');
    metrics.increment('match.requests');
    expect(metrics.snapshot().counters['match.requests']).toBe(2);
  });

  it('accumulates an explicit increment value', () => {
    const metrics = createInMemoryMetrics();
    metrics.increment('llm.calls', 3);
    metrics.increment('llm.calls', 2);
    expect(metrics.snapshot().counters['llm.calls']).toBe(5);
  });

  it('reset clears all recorded counters', () => {
    const metrics = createInMemoryMetrics();
    metrics.increment('match.requests');
    metrics.reset();
    expect(metrics.snapshot().counters['match.requests']).toBeUndefined();
  });
});

describe('createInMemoryMetrics — observations', () => {
  it('computes count/sum/min/max/percentiles over recorded samples', () => {
    const metrics = createInMemoryMetrics();
    for (const value of [1, 2, 3, 4, 5]) {
      metrics.observe('match.score', value);
    }
    const stats = metrics.snapshot().observations['match.score'];
    expect(stats).toEqual({ count: 5, sum: 15, min: 1, max: 5, p50: 3, p95: 5 });
  });

  it('reset clears all recorded observations', () => {
    const metrics = createInMemoryMetrics();
    metrics.observe('match.score', 1);
    metrics.reset();
    expect(metrics.snapshot().observations['match.score']).toBeUndefined();
  });

  it('omits a metric from the snapshot until it has at least one sample', () => {
    const metrics = createInMemoryMetrics();
    expect(metrics.snapshot().observations['match.score']).toBeUndefined();
  });
});

describe('createNoopMetrics', () => {
  it('never throws and records nothing observable', () => {
    const metrics = createNoopMetrics();
    expect(() => {
      metrics.increment('match.requests');
      metrics.observe('match.score', 42);
    }).not.toThrow();
  });
});

describe('llmCallRatio', () => {
  it('is 0 when there have been no requests', () => {
    const empty: MetricsSnapshot = { counters: {}, observations: {} };
    expect(llmCallRatio(empty)).toBe(0);
  });

  it('divides llm.calls by match.requests', () => {
    const snapshot: MetricsSnapshot = {
      counters: { 'match.requests': 4, 'llm.calls': 2 },
      observations: {},
    };
    expect(llmCallRatio(snapshot)).toBe(0.5);
  });

  it('is 0 when there were requests but no llm calls', () => {
    const snapshot: MetricsSnapshot = {
      counters: { 'match.requests': 4 },
      observations: {},
    };
    expect(llmCallRatio(snapshot)).toBe(0);
  });
});

describe('cache hit rate helpers', () => {
  it('semanticCacheHitRate is 0 with no hits or misses', () => {
    expect(semanticCacheHitRate({ counters: {}, observations: {} })).toBe(0);
  });

  it('semanticCacheHitRate divides hits by hits + misses', () => {
    const snapshot: MetricsSnapshot = {
      counters: { 'semantic.cache.hit': 3, 'semantic.cache.miss': 1 },
      observations: {},
    };
    expect(semanticCacheHitRate(snapshot)).toBe(0.75);
  });

  it('recommendationCacheHitRate divides hits by hits + misses', () => {
    const snapshot: MetricsSnapshot = {
      counters: { 'recommendation.cache.hit': 1, 'recommendation.cache.miss': 3 },
      observations: {},
    };
    expect(recommendationCacheHitRate(snapshot)).toBe(0.25);
  });
});
