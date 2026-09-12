import type { ActivityId, ActivityRelation, CategoryId, TaxonomyIndex } from './types.js';
import type { ActivityNode, AlgorithmConfig, TaxonomyConfig } from '../config/types.js';
import { normalizeText } from './text.js';

/**
 * Ancestors more than one hop up still count as PARENT/CHILD (see
 * `relation`), but the configured score decays per extra hop so a
 * great-grandparent doesn't score as closely as a direct parent.
 */
const ANCESTOR_DECAY_PER_HOP = 0.85;

/** Stage-1 retrieval bound: `expand` never returns more than this many activity ids. */
const EXPANSION_CAP = 40;

/**
 * Build the closure that returns the same taxonomy-index closures on every
 * call. Everything expensive (parent chains, children, category groupings,
 * inherited tags, the related-id closure) is precomputed once here so every
 * `TaxonomyIndex` method is an O(1)-ish map lookup at request time.
 */
export function buildTaxonomyIndex(taxonomy: TaxonomyConfig, config: AlgorithmConfig): TaxonomyIndex {
  const nodeById = new Map<ActivityId, ActivityNode>();
  for (const node of taxonomy.activities) {
    nodeById.set(node.id, node);
  }

  // `id -> direct children`. There is no `category -> activities` map: no
  // `TaxonomyIndex` method needs "all activities in category X" as a group
  // (categoryOf already answers every category-based question this index
  // exposes), so precomputing it would be dead state.
  const childrenById = new Map<ActivityId, ActivityId[]>();
  for (const node of taxonomy.activities) {
    if (node.parentId !== undefined) {
      const siblings = childrenById.get(node.parentId);
      if (siblings === undefined) {
        childrenById.set(node.parentId, [node.id]);
      } else {
        siblings.push(node.id);
      }
    }
  }

  // Ancestor chain, immediate parent first, root last. Cycle-guarded so a
  // malformed override taxonomy degrades to a truncated chain instead of an
  // infinite loop.
  const ancestorChainById = new Map<ActivityId, ActivityId[]>();
  for (const node of taxonomy.activities) {
    const chain: ActivityId[] = [];
    const visited = new Set<ActivityId>([node.id]);
    let current: ActivityNode | undefined = node;
    while (current?.parentId !== undefined && !visited.has(current.parentId)) {
      const parentId = current.parentId;
      chain.push(parentId);
      visited.add(parentId);
      current = nodeById.get(parentId);
    }
    ancestorChainById.set(node.id, chain);
  }

  // Symmetric closure over explicit `relatedIds`: if A lists B, both A->B
  // and B->A resolve as RELATED. A curated cross-link is treated as
  // deliberate, so it should hold regardless of which side declared it.
  const relatedById = new Map<ActivityId, Set<ActivityId>>();
  const addRelated = (a: ActivityId, b: ActivityId): void => {
    const set = relatedById.get(a);
    if (set === undefined) {
      relatedById.set(a, new Set([b]));
    } else {
      set.add(b);
    }
  };
  for (const node of taxonomy.activities) {
    for (const relatedId of node.relatedIds ?? []) {
      addRelated(node.id, relatedId);
      addRelated(relatedId, node.id);
    }
  }

  const inheritedTagsById = new Map<ActivityId, string[]>();
  for (const node of taxonomy.activities) {
    const seen = new Set<string>();
    const tags: string[] = [];
    const addAll = (raw: string[]): void => {
      for (const tag of raw) {
        const normalized = normalizeText(tag);
        if (normalized.length === 0 || seen.has(normalized)) continue;
        seen.add(normalized);
        tags.push(normalized);
      }
    };
    addAll(node.tags);
    for (const ancestorId of ancestorChainById.get(node.id) ?? []) {
      const ancestor = nodeById.get(ancestorId);
      if (ancestor !== undefined) addAll(ancestor.tags);
    }
    inheritedTagsById.set(node.id, tags);
  }

  const allIds: ActivityId[] = taxonomy.activities.map((node) => node.id);

  function hasActivity(id: string): boolean {
    return nodeById.has(id);
  }

  function categoryOf(id: ActivityId): CategoryId | undefined {
    return nodeById.get(id)?.categoryId;
  }

  function tagsFor(id: ActivityId): string[] {
    return [...(inheritedTagsById.get(id) ?? [])];
  }

  function resolveSynonym(normalizedText: string): ActivityId | undefined {
    return taxonomy.synonyms[normalizedText];
  }

  /** 1-indexed hop count from `descendantId` up to `ancestorId`, or undefined if not an ancestor. */
  function ancestorHop(descendantId: ActivityId, ancestorId: ActivityId): number | undefined {
    const chain = ancestorChainById.get(descendantId) ?? [];
    const index = chain.indexOf(ancestorId);
    return index === -1 ? undefined : index + 1;
  }

  /**
   * `relation(a, b) === 'PARENT'` means b is a's parent (the ancestor
   * direction: `relation('treadmill', 'workout') === 'PARENT'`); `'CHILD'`
   * is the reverse (b is a descendant of a). Unknown ids resolve to
   * `'UNRELATED'` rather than throwing, mirroring `similarity`'s handling of
   * unknown ids.
   */
  function relation(a: ActivityId, b: ActivityId): ActivityRelation {
    if (!hasActivity(a) || !hasActivity(b)) return 'UNRELATED';
    if (a === b) return 'EXACT';
    if (ancestorHop(a, b) !== undefined) return 'PARENT';
    if (ancestorHop(b, a) !== undefined) return 'CHILD';
    if (relatedById.get(a)?.has(b) === true) return 'RELATED';

    const parentA = nodeById.get(a)?.parentId;
    const parentB = nodeById.get(b)?.parentId;
    if (parentA !== undefined && parentA === parentB) return 'SIBLING';

    const categoryA = categoryOf(a);
    const categoryB = categoryOf(b);
    if (categoryA !== undefined && categoryA === categoryB) return 'SAME_CATEGORY';

    return 'UNRELATED';
  }

  function applyAncestorDecay(baseScore: number, hops: number): number {
    // hops === 1 is a direct parent/child: full, undecayed score. Each
    // additional hop multiplies by ANCESTOR_DECAY_PER_HOP, so a
    // grandparent/grandchild scores baseScore * 0.85, a great-grandparent
    // baseScore * 0.85^2, etc.
    return baseScore * Math.pow(ANCESTOR_DECAY_PER_HOP, hops - 1);
  }

  /**
   * Deterministic similarity in [0, 1] driven by `config.activitySimilarity`.
   * Not required to be symmetric by design: PARENT and CHILD use different
   * configured values (`activitySimilarity.parent` vs `.child`), so
   * similarity(treadmill, workout) and similarity(workout, treadmill) can
   * legitimately differ.
   *
   * `RELATED` (explicit `relatedIds` cross-links) has its own configured
   * value, deliberately above `sibling`: a hand-authored link is a stronger
   * signal than merely sharing a parent.
   */
  function similarity(a: ActivityId, b: ActivityId): number {
    // Unknown ids resolve to 0 even when a === b: reflexivity is a property
    // of the controlled vocabulary, not of arbitrary input strings.
    if (!hasActivity(a) || !hasActivity(b)) return 0;

    const rel = relation(a, b);
    switch (rel) {
      case 'EXACT':
        return config.activitySimilarity.exact;
      case 'PARENT': {
        const hops = ancestorHop(a, b) ?? 1;
        return applyAncestorDecay(config.activitySimilarity.parent, hops);
      }
      case 'CHILD': {
        const hops = ancestorHop(b, a) ?? 1;
        return applyAncestorDecay(config.activitySimilarity.child, hops);
      }
      case 'SIBLING':
        return config.activitySimilarity.sibling;
      case 'RELATED':
        return config.activitySimilarity.related;
      case 'SAME_CATEGORY':
        return config.activitySimilarity.sameCategory;
      case 'UNRELATED':
        return config.activitySimilarity.unrelated;
    }
  }

  /**
   * Widen intent activities into the activity + category ids worth querying
   * in stage-1 retrieval: self, the full ancestor chain, all descendants,
   * direct siblings, and explicit `relatedIds`. Bounded at `EXPANSION_CAP`
   * (40) activity ids total across all inputs so a `CandidateQuery` never
   * carries an unbounded id list into the repository layer.
   */
  function expand(activityIds: ActivityId[]): { activityIds: ActivityId[]; categoryIds: CategoryId[] } {
    const result = new Set<ActivityId>();

    for (const id of activityIds) {
      if (result.size >= EXPANSION_CAP) break;
      if (!hasActivity(id)) continue;
      result.add(id);

      for (const ancestorId of ancestorChainById.get(id) ?? []) {
        if (result.size >= EXPANSION_CAP) break;
        result.add(ancestorId);
      }

      const descendantQueue: ActivityId[] = [...(childrenById.get(id) ?? [])];
      while (descendantQueue.length > 0 && result.size < EXPANSION_CAP) {
        const descendantId = descendantQueue.shift();
        if (descendantId === undefined) break;
        result.add(descendantId);
        for (const grandchild of childrenById.get(descendantId) ?? []) {
          descendantQueue.push(grandchild);
        }
      }

      const parentId = nodeById.get(id)?.parentId;
      if (parentId !== undefined) {
        for (const siblingId of childrenById.get(parentId) ?? []) {
          if (result.size >= EXPANSION_CAP) break;
          if (siblingId !== id) result.add(siblingId);
        }
      }

      for (const relatedId of relatedById.get(id) ?? []) {
        if (result.size >= EXPANSION_CAP) break;
        result.add(relatedId);
      }
    }

    const expandedActivityIds = [...result].slice(0, EXPANSION_CAP);
    const categoryIds = [
      ...new Set(
        expandedActivityIds
          .map((id) => categoryOf(id))
          .filter((id): id is CategoryId => id !== undefined),
      ),
    ];
    return { activityIds: expandedActivityIds, categoryIds };
  }

  function allActivityIds(): ActivityId[] {
    return [...allIds];
  }

  return {
    hasActivity,
    categoryOf,
    tagsFor,
    resolveSynonym,
    relation,
    similarity,
    expand,
    allActivityIds,
  };
}
