import { describe, it, expect } from 'vitest';
import { buildTaxonomyIndex } from '../../src/core/taxonomyIndex.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { DEFAULT_TAXONOMY } from '../../src/config/taxonomy.js';
import type { TaxonomyConfig } from '../../src/config/types.js';
import { makeTaxonomyIndex } from '../../tests/support/factories.js';

const taxonomy = makeTaxonomyIndex();
const { activitySimilarity } = DEFAULT_CONFIG;

describe('hasActivity / categoryOf', () => {
  it('recognizes ids in the controlled vocabulary', () => {
    expect(taxonomy.hasActivity('treadmill')).toBe(true);
  });

  it('rejects ids outside the controlled vocabulary', () => {
    expect(taxonomy.hasActivity('parkour')).toBe(false);
  });

  it('returns the category id for a known activity', () => {
    expect(taxonomy.categoryOf('treadmill')).toBe('fitness');
  });

  it('returns undefined for an unknown activity', () => {
    expect(taxonomy.categoryOf('parkour')).toBeUndefined();
  });
});

describe('tagsFor', () => {
  it("includes the activity's own tags plus inherited, de-duplicated parent tags", () => {
    // treadmill's own tags include "workout", which is also one of its
    // parent's tags -- it must appear only once in the result.
    expect(taxonomy.tagsFor('treadmill')).toEqual([
      'treadmill',
      'running',
      'cardio',
      'workout',
      'fitness',
      'exercise',
      'gym',
    ]);
  });

  it('returns just the root tags for an activity with no parent', () => {
    expect(taxonomy.tagsFor('workout')).toEqual(['workout', 'fitness', 'exercise', 'gym']);
  });

  it('returns an empty array for an unknown activity', () => {
    expect(taxonomy.tagsFor('parkour')).toEqual([]);
  });

  it('returns a fresh array on every call (callers cannot mutate internal state)', () => {
    const first = taxonomy.tagsFor('treadmill');
    first.push('mutated');
    expect(taxonomy.tagsFor('treadmill')).not.toContain('mutated');
  });
});

describe('resolveSynonym', () => {
  it('resolves a known alias to its canonical activity id', () => {
    expect(taxonomy.resolveSynonym('gym')).toBe('workout');
    expect(taxonomy.resolveSynonym('bball')).toBe('basketball');
  });

  it('returns undefined for an unrecognized alias', () => {
    expect(taxonomy.resolveSynonym('parkour')).toBeUndefined();
  });
});

describe('relation', () => {
  it('is EXACT for identical ids', () => {
    expect(taxonomy.relation('treadmill', 'treadmill')).toBe('EXACT');
  });

  it('is PARENT from a child to its direct parent', () => {
    expect(taxonomy.relation('treadmill', 'workout')).toBe('PARENT');
  });

  it('is CHILD from a parent to its direct child', () => {
    expect(taxonomy.relation('workout', 'treadmill')).toBe('CHILD');
  });

  it('is RELATED for an explicit relatedIds cross-link, symmetrically', () => {
    expect(taxonomy.relation('running', 'treadmill')).toBe('RELATED');
    expect(taxonomy.relation('treadmill', 'running')).toBe('RELATED');
  });

  it('is SIBLING for two activities sharing a direct parent with no other link', () => {
    // programming and robotics are both direct children of coding, and are
    // not cross-linked via relatedIds.
    expect(taxonomy.relation('programming', 'robotics')).toBe('SIBLING');
  });

  it('is SAME_CATEGORY for unrelated activities in the same category', () => {
    expect(taxonomy.relation('basketball', 'workout')).toBe('SAME_CATEGORY');
  });

  it('is UNRELATED across categories', () => {
    expect(taxonomy.relation('painting', 'treadmill')).toBe('UNRELATED');
  });

  it('is UNRELATED when either id is unknown', () => {
    expect(taxonomy.relation('parkour', 'treadmill')).toBe('UNRELATED');
    expect(taxonomy.relation('treadmill', 'parkour')).toBe('UNRELATED');
  });
});

describe('similarity', () => {
  it('scores an exact match at the configured exact value', () => {
    expect(taxonomy.similarity('treadmill', 'treadmill')).toBe(activitySimilarity.exact);
  });

  it('scores a direct child->parent lookup at the configured parent value, undecayed', () => {
    expect(taxonomy.similarity('treadmill', 'workout')).toBe(activitySimilarity.parent);
  });

  it('scores a direct parent->child lookup at the configured child value, undecayed', () => {
    expect(taxonomy.similarity('workout', 'treadmill')).toBe(activitySimilarity.child);
  });

  it('scores an explicit relatedIds cross-link at the configured related value', () => {
    expect(taxonomy.similarity('running', 'treadmill')).toBe(activitySimilarity.related);
  });

  it('scores same-category-only activities at the configured sameCategory value', () => {
    expect(taxonomy.similarity('basketball', 'workout')).toBe(activitySimilarity.sameCategory);
  });

  it('scores cross-category activities at the configured unrelated value', () => {
    expect(taxonomy.similarity('painting', 'treadmill')).toBe(activitySimilarity.unrelated);
  });

  it('returns 0 for unknown ids regardless of config, even when both sides are equal', () => {
    expect(taxonomy.similarity('parkour', 'parkour')).toBe(0);
    expect(taxonomy.similarity('parkour', 'treadmill')).toBe(0);
  });

  it('decays multi-hop ancestor/descendant similarity per extra hop', () => {
    // A synthetic 3-level chain the real taxonomy does not otherwise have,
    // built purely to exercise ANCESTOR_DECAY_PER_HOP in isolation.
    const chain: TaxonomyConfig = {
      categories: [{ id: 'c', name: 'C' }],
      activities: [
        { id: 'root', categoryId: 'c', tags: [] },
        { id: 'mid', categoryId: 'c', parentId: 'root', tags: [] },
        { id: 'leaf', categoryId: 'c', parentId: 'mid', tags: [] },
      ],
      synonyms: {},
    };
    const index = buildTaxonomyIndex(chain, DEFAULT_CONFIG);

    // Direct (1-hop) parent/child: full configured value.
    expect(index.similarity('leaf', 'mid')).toBe(activitySimilarity.parent);
    expect(index.similarity('mid', 'leaf')).toBe(activitySimilarity.child);

    // 2-hop grandparent/grandchild: decayed by one extra hop (^1).
    const decay = 0.85;
    expect(index.similarity('leaf', 'root')).toBeCloseTo(activitySimilarity.parent * decay, 10);
    expect(index.similarity('root', 'leaf')).toBeCloseTo(activitySimilarity.child * decay, 10);
  });
});

describe('expand', () => {
  it('widens an activity to itself, its ancestors, siblings, and related ids', () => {
    const result = taxonomy.expand(['treadmill']);
    expect(result.activityIds).toEqual(['treadmill', 'workout', 'running']);
    expect(result.categoryIds).toEqual(['fitness']);
  });

  it('returns empty results for an empty input list', () => {
    expect(taxonomy.expand([])).toEqual({ activityIds: [], categoryIds: [] });
  });

  it('ignores unknown activity ids rather than throwing', () => {
    expect(taxonomy.expand(['parkour'])).toEqual({ activityIds: [], categoryIds: [] });
  });

  it('de-duplicates across multiple inputs that expand into overlapping sets', () => {
    const result = taxonomy.expand(['treadmill', 'running']);
    // Both expand into the same {treadmill, workout, running} neighborhood;
    // the union must not contain duplicates.
    expect(new Set(result.activityIds).size).toBe(result.activityIds.length);
    expect(result.activityIds.sort()).toEqual(['running', 'treadmill', 'workout']);
  });

  it('never returns more than the expansion cap, even for a very wide taxonomy', () => {
    const wide: TaxonomyConfig = {
      categories: [{ id: 'c', name: 'C' }],
      activities: [
        { id: 'root', categoryId: 'c', tags: [] },
        ...Array.from({ length: 60 }, (_, i) => ({
          id: `child-${i}`,
          categoryId: 'c',
          parentId: 'root',
          tags: [],
        })),
      ],
      synonyms: {},
    };
    const index = buildTaxonomyIndex(wide, DEFAULT_CONFIG);
    const result = index.expand(['child-0']);
    expect(result.activityIds.length).toBeLessThanOrEqual(40);
  });
});

describe('allActivityIds', () => {
  it('includes every activity id in the taxonomy', () => {
    const ids = taxonomy.allActivityIds();
    expect(ids).toContain('treadmill');
    expect(ids).toContain('painting');
    expect(ids.length).toBe(DEFAULT_TAXONOMY.activities.length);
  });

  it('returns a fresh array each call so callers cannot mutate internal state', () => {
    const first = taxonomy.allActivityIds();
    first.push('mutated');
    expect(taxonomy.allActivityIds()).not.toContain('mutated');
  });
});
