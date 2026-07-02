import { describe, it, expect } from 'vitest';
import { applyGraphRanking } from '../src/graph-ranking.js';
import type { SearchResult, SearchUnit } from '../src/types.js';

function unit(
  nodeId: string,
  opts: Partial<SearchUnit> = {},
): SearchUnit {
  return {
    unitId: opts.unitId ?? nodeId,
    nodeId,
    chunkIndex: 0,
    text: `Content for ${nodeId}`,
    title: opts.title ?? nodeId,
    cluster: opts.cluster ?? 'default',
    connections: opts.connections ?? [],
    metadata: opts.metadata ?? {},
    parentId: opts.parentId,
  };
}

function result(
  nodeId: string,
  score: number,
  opts: Partial<SearchResult> = {},
): SearchResult {
  return {
    unitId: opts.unitId ?? nodeId,
    nodeId,
    chunkIndex: 0,
    title: opts.title ?? nodeId,
    cluster: opts.cluster ?? 'default',
    score,
    snippet: opts.snippet ?? `Snippet for ${nodeId}`,
    connections: opts.connections ?? [],
    metadata: opts.metadata ?? {},
  };
}

describe('applyGraphRanking', () => {
  it('returns empty when no results', () => {
    const ranked = applyGraphRanking([], []);
    expect(ranked.results).toEqual([]);
    expect(ranked.suggestions).toEqual([]);
  });

  it('boosts neighbor nodes of top results', () => {
    // A connects to B; C has no connection to A and is in a different cluster
    const units: SearchUnit[] = [
      unit('A', { connections: ['B'] }),
      unit('B', { connections: ['A'] }),
      unit('C', { cluster: 'other' }),
    ];

    // A is top result; C scores higher than B initially
    const results: SearchResult[] = [
      result('A', 0.9),
      result('C', 0.75, { cluster: 'other' }),
      result('B', 0.7),
    ];

    const ranked = applyGraphRanking(results, units);

    // B gets partial neighborBoost(+0.025) + clusterAffinity(+0.02) = 0.745
    // C gets no boost (different cluster, not a neighbor) = 0.75
    // B doesn't surpass C with partial boost, but it should be boosted
    const bResult = ranked.results.find((r) => r.nodeId === 'B')!;
    expect(bResult.score).toBeGreaterThan(0.7);
  });

  it('boosts results sharing cluster with top result', () => {
    const units: SearchUnit[] = [
      unit('A', { cluster: 'core' }),
      unit('B', { cluster: 'core' }),
      unit('C', { cluster: 'other' }),
    ];

    const results: SearchResult[] = [
      result('A', 0.9, { cluster: 'core' }),
      result('C', 0.80, { cluster: 'other' }),
      result('B', 0.79, { cluster: 'core' }),
    ];

    const ranked = applyGraphRanking(results, units);
    const bResult = ranked.results.find((r) => r.nodeId === 'B')!;
    // B gets cluster affinity boost (+0.02)
    expect(bResult.score).toBeCloseTo(0.81, 2);
  });

  it('boosts parent nodes of top results', () => {
    const units: SearchUnit[] = [
      unit('parent', { cluster: 'core' }),
      unit('child', { cluster: 'core', parentId: 'parent' }),
      unit('filler1', { cluster: 'other' }),
      unit('filler2', { cluster: 'other' }),
      unit('other', { cluster: 'other' }),
    ];

    // child is top; parent is rank 4+ (outside top-3) so hierarchy boost applies
    const results: SearchResult[] = [
      result('child', 0.9, { cluster: 'core' }),
      result('filler1', 0.80, { cluster: 'other' }),
      result('filler2', 0.78, { cluster: 'other' }),
      result('other', 0.75, { cluster: 'other' }),
      result('parent', 0.72, { cluster: 'core' }),
    ];

    const ranked = applyGraphRanking(results, units);
    const parentResult = ranked.results.find((r) => r.nodeId === 'parent')!;
    // parent gets hierarchy boost (+0.03) + cluster affinity (+0.02) = 0.77
    expect(parentResult.score).toBeCloseTo(0.77, 2);
  });

  it('clamps scores to [0, 1]', () => {
    const units: SearchUnit[] = [
      unit('A', { connections: ['B'] }),
      unit('B', { connections: ['A'] }),
    ];

    const results: SearchResult[] = [
      result('A', 0.99),
      result('B', 0.98),
    ];

    const ranked = applyGraphRanking(results, units);
    for (const r of ranked.results) {
      expect(r.score).toBeLessThanOrEqual(1);
      expect(r.score).toBeGreaterThanOrEqual(0);
    }
  });

  it('generates neighbor suggestions for nodes not in results', () => {
    const units: SearchUnit[] = [
      unit('A', { connections: ['B', 'C'] }),
      unit('B', { title: 'Node B', cluster: 'infra' }),
      unit('C', { title: 'Node C', cluster: 'core' }),
    ];

    // Only A is in results; B and C should appear as suggestions
    const results: SearchResult[] = [
      result('A', 0.9),
    ];

    const ranked = applyGraphRanking(results, units);
    expect(ranked.suggestions.length).toBe(2);
    const nodeIds = ranked.suggestions.map((s) => s.nodeId);
    expect(nodeIds).toContain('B');
    expect(nodeIds).toContain('C');
    expect(ranked.suggestions[0].reason).toBe('neighbor');
    expect(ranked.suggestions[0].sourceNodeIds).toContain('A');
  });

  it('generates parent suggestions', () => {
    const units: SearchUnit[] = [
      unit('parent-node', { title: 'Parent' }),
      unit('child-node', { title: 'Child', parentId: 'parent-node' }),
    ];

    const results: SearchResult[] = [
      result('child-node', 0.9, { title: 'Child' }),
    ];

    const ranked = applyGraphRanking(results, units);
    const parentSuggestion = ranked.suggestions.find((s) => s.nodeId === 'parent-node');
    expect(parentSuggestion).toBeDefined();
    expect(parentSuggestion!.reason).toBe('parent');
  });

  it('generates child suggestions', () => {
    const units: SearchUnit[] = [
      unit('parent-node', { title: 'Parent' }),
      unit('child-1', { title: 'Child 1', parentId: 'parent-node' }),
      unit('child-2', { title: 'Child 2', parentId: 'parent-node' }),
    ];

    const results: SearchResult[] = [
      result('parent-node', 0.9, { title: 'Parent' }),
    ];

    const ranked = applyGraphRanking(results, units);
    const childIds = ranked.suggestions.filter((s) => s.reason === 'child').map((s) => s.nodeId);
    expect(childIds).toContain('child-1');
    expect(childIds).toContain('child-2');
  });

  it('excludes result nodes from suggestions', () => {
    const units: SearchUnit[] = [
      unit('A', { connections: ['B'] }),
      unit('B', { connections: ['A'] }),
    ];

    // Both A and B are in results — B should NOT appear as suggestion
    const results: SearchResult[] = [
      result('A', 0.9),
      result('B', 0.8),
    ];

    const ranked = applyGraphRanking(results, units);
    expect(ranked.suggestions.length).toBe(0);
  });

  it('respects maxSuggestions config', () => {
    const units: SearchUnit[] = [
      unit('A', { connections: ['B', 'C', 'D', 'E', 'F'] }),
      unit('B'), unit('C'), unit('D'), unit('E'), unit('F'),
    ];

    const results: SearchResult[] = [result('A', 0.9)];
    const ranked = applyGraphRanking(results, units, { maxSuggestions: 2 });
    expect(ranked.suggestions.length).toBe(2);
  });

  it('custom boost config overrides defaults', () => {
    const units: SearchUnit[] = [
      unit('A', { connections: ['B'] }),
      unit('B', { connections: ['A'], cluster: 'other' }),
      unit('C', { cluster: 'other' }),
    ];

    const results: SearchResult[] = [
      result('A', 0.9),
      result('C', 0.75, { cluster: 'other' }),
      result('B', 0.70, { cluster: 'other' }),
    ];

    // B is a mutual neighbor of A (both in top 3), gets partial boost: 0.10 * 0.5 = 0.05
    const ranked = applyGraphRanking(results, units, { neighborBoost: 0.10 });
    const bResult = ranked.results.find((r) => r.nodeId === 'B')!;
    expect(bResult.score).toBeCloseTo(0.75, 2);
  });

  it('handles multi-chunk nodes correctly', () => {
    const units: SearchUnit[] = [
      unit('A', { unitId: 'A-0', connections: ['B'] }),
      { ...unit('A', { unitId: 'A-1', connections: ['B'] }), chunkIndex: 1 },
      unit('B', { title: 'Node B' }),
    ];

    const results: SearchResult[] = [
      result('A', 0.9, { unitId: 'A-0' }),
    ];

    const ranked = applyGraphRanking(results, units);
    // B should appear as suggestion (neighbor of A)
    expect(ranked.suggestions.some((s) => s.nodeId === 'B')).toBe(true);
  });

  it('never leaks an access-filtered node via suggestions (AF-001 for the suggestions path, #102)', () => {
    // A public node adjacent to a restricted node. In `include` index mode the
    // restricted unit is present in `allUnits` (carrying its label) and is only
    // kept out of results by the host's `filterUnit`. Graph ranking must apply
    // the SAME filter so the restricted node's id/title/cluster can never ride
    // along in `suggestions`.
    const units: SearchUnit[] = [
      unit('pub', { title: 'Public Doc', connections: ['secret'] }),
      unit('secret', {
        title: 'SECRET Salaries',
        cluster: 'hr',
        connections: ['pub'],
        parentId: undefined,
      }),
    ];
    const results: SearchResult[] = [result('pub', 0.9)];
    const filterUnit = (u: SearchUnit): boolean => u.nodeId !== 'secret';

    const ranked = applyGraphRanking(results, units, undefined, filterUnit);

    // The restricted neighbor was the only suggestion candidate — it must be gone.
    expect(ranked.suggestions).toEqual([]);
    const blob = JSON.stringify(ranked.suggestions);
    expect(blob).not.toContain('secret');
    expect(blob).not.toContain('SECRET Salaries');
    expect(ranked.suggestions.map((s) => s.nodeId)).not.toContain('secret');
  });

  it('still surfaces non-filtered neighbors when a filter is supplied', () => {
    const units: SearchUnit[] = [
      unit('pub', { connections: ['secret', 'ok'] }),
      unit('secret', { title: 'SECRET', connections: ['pub'] }),
      unit('ok', { title: 'Related Public', connections: ['pub'] }),
    ];
    const results: SearchResult[] = [result('pub', 0.9)];
    const ranked = applyGraphRanking(
      results,
      units,
      undefined,
      (u) => u.nodeId !== 'secret',
    );
    const ids = ranked.suggestions.map((s) => s.nodeId);
    expect(ids).toContain('ok');
    expect(ids).not.toContain('secret');
  });

  it('accumulates multiple source nodes for shared suggestions', () => {
    // D is a neighbor of both A and B (top results)
    const units: SearchUnit[] = [
      unit('A', { connections: ['D'] }),
      unit('B', { connections: ['D'] }),
      unit('C'),
      unit('D', { title: 'Shared Neighbor' }),
    ];

    const results: SearchResult[] = [
      result('A', 0.9),
      result('B', 0.85),
      result('C', 0.7),
    ];

    const ranked = applyGraphRanking(results, units);
    const dSuggestion = ranked.suggestions.find((s) => s.nodeId === 'D');
    expect(dSuggestion).toBeDefined();
    // D should have both A and B as sources
    expect(dSuggestion!.sourceNodeIds).toContain('A');
    expect(dSuggestion!.sourceNodeIds).toContain('B');
    expect(dSuggestion!.sourceNodeIds.length).toBe(2);
  });
});
