import { describe, it, expect } from 'vitest';
import { createSearchEngine } from '../src/search-engine.js';
import type { EmbeddingProvider } from '../src/providers/interface.js';
import type { EmbeddingArtifact, SearchUnit, EmbeddingVector } from '../src/types.js';

/** Mock provider that returns predictable vectors. */
function mockProvider(responseMap: Record<string, number[]>): EmbeddingProvider {
  return {
    name: 'mock',
    model: 'mock-model',
    dimensions: 3,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => responseMap[t] ?? [0, 0, 0]);
    },
  };
}

function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
}

function makeArtifact(
  units: SearchUnit[],
  vectors: EmbeddingVector[],
): EmbeddingArtifact {
  return {
    meta: {
      version: 1,
      contentHash: 'test',
      model: 'mock-model',
      dimensions: 3,
      unitCount: units.length,
    },
    units,
    vectors,
  };
}

describe('createSearchEngine', () => {
  const auditVec = normalize([1, 0, 0]);
  const graphVec = normalize([0, 1, 0]);
  const mixedVec = normalize([0.7, 0.7, 0]);

  const units: SearchUnit[] = [
    {
      unitId: 'audit',
      nodeId: 'audit',
      chunkIndex: 0,
      text: 'Title: Audit\n\nAudit validation checks structural integrity',
      title: 'Audit',
      cluster: 'engine',
      connections: ['graph'],
      metadata: {},
    },
    {
      unitId: 'graph',
      nodeId: 'graph',
      chunkIndex: 0,
      text: 'Title: Graph\n\nGraph engine processes nodes and edges',
      title: 'Graph Engine',
      cluster: 'engine',
      connections: ['audit'],
      metadata: {},
    },
    {
      unitId: 'readme',
      nodeId: 'readme',
      chunkIndex: 0,
      text: 'Title: README\n\nProject overview and getting started',
      title: 'README',
      cluster: 'docs',
      connections: [],
      metadata: {},
    },
  ];

  const vectors: EmbeddingVector[] = [
    { unitId: 'audit', vector: auditVec, model: 'mock-model', dimensions: 3 },
    { unitId: 'graph', vector: graphVec, model: 'mock-model', dimensions: 3 },
    { unitId: 'readme', vector: mixedVec, model: 'mock-model', dimensions: 3 },
  ];

  const artifact = makeArtifact(units, vectors);

  it('returns results ranked by relevance', async () => {
    const provider = mockProvider({
      'audit validation': normalize([1, 0, 0]), // closest to audit vector
    });
    const engine = createSearchEngine(artifact, provider);

    const results = await engine.search('audit validation');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].nodeId).toBe('audit');
    expect(results[0].score).toBeGreaterThan(results[results.length - 1].score);
  });

  it('respects cluster filter', async () => {
    const provider = mockProvider({
      'query': normalize([0.5, 0.5, 0.5]),
    });
    const engine = createSearchEngine(artifact, provider);

    const results = await engine.search('query', { cluster: 'docs' });
    expect(results.every((r) => r.cluster === 'docs')).toBe(true);
    expect(results.length).toBe(1);
    expect(results[0].nodeId).toBe('readme');
  });

  it('respects minScore threshold', async () => {
    const provider = mockProvider({
      'query': normalize([1, 0, 0]), // only close to audit
    });
    const engine = createSearchEngine(artifact, provider);

    const results = await engine.search('query', { minScore: 0.9 });
    // Only audit should pass the high threshold
    expect(results.length).toBeLessThanOrEqual(1);
    if (results.length > 0) {
      expect(results[0].score).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('SearchResult contains full metadata', async () => {
    const provider = mockProvider({
      'audit': normalize([1, 0, 0]),
    });
    const engine = createSearchEngine(artifact, provider);

    const results = await engine.search('audit', { limit: 1 });
    const result = results[0];
    expect(result).toHaveProperty('nodeId');
    expect(result).toHaveProperty('title');
    expect(result).toHaveProperty('cluster');
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('snippet');
    expect(result).toHaveProperty('connections');
    expect(result.connections).toEqual(['graph']);
  });

  it('respects limit option', async () => {
    const provider = mockProvider({
      'query': normalize([0.5, 0.5, 0.5]),
    });
    const engine = createSearchEngine(artifact, provider);

    const results = await engine.search('query', { limit: 1 });
    expect(results).toHaveLength(1);
  });
});
