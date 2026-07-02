import { describe, it, expect } from 'vitest';
import { createFaissEngine } from '../src/faiss-engine.js';
import type { EmbeddingProvider } from '../src/providers/interface.js';
import type { EmbeddingArtifact, SearchUnit, EmbeddingVector } from '../src/types.js';

function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
}

function mockProvider(): EmbeddingProvider {
  return {
    name: 'mock',
    model: 'mock-model',
    dimensions: 3,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(() => normalize([1, 0, 0]));
    },
  };
}

const units: SearchUnit[] = [
  {
    unitId: 'node-a',
    nodeId: 'node-a',
    chunkIndex: 0,
    text: 'Title: Node A\n\nContent about audit validation',
    title: 'Node A',
    cluster: 'core',
    connections: ['node-b'],
    metadata: {},
  },
  {
    unitId: 'node-b',
    nodeId: 'node-b',
    chunkIndex: 0,
    text: 'Title: Node B\n\nContent about graph rendering',
    title: 'Node B',
    cluster: 'ui',
    connections: ['node-a'],
    metadata: {},
  },
];

const vectors: EmbeddingVector[] = [
  { unitId: 'node-a', vector: normalize([1, 0, 0]), model: 'mock-model', dimensions: 3 },
  { unitId: 'node-b', vector: normalize([0, 1, 0]), model: 'mock-model', dimensions: 3 },
];

const artifact: EmbeddingArtifact = {
  meta: {
    version: 1,
    contentHash: 'testhash',
    model: 'mock-model',
    dimensions: 3,
    unitCount: 2,
  },
  units,
  vectors,
};

describe('createFaissEngine', () => {
  it('falls back to pure-JS cosine when faiss-node is not installed (default)', async () => {
    const result = await createFaissEngine(artifact, mockProvider());
    expect(result.accelerated).toBe(false);
    expect(result.engine).toBeDefined();
    expect(result.engine.search).toBeTypeOf('function');
  });

  it('fallback engine returns valid search results', async () => {
    const { engine, accelerated } = await createFaissEngine(artifact, mockProvider());
    expect(accelerated).toBe(false);

    const results = await engine.search('test query');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty('nodeId');
    expect(results[0]).toHaveProperty('score');
    expect(results[0]).toHaveProperty('snippet');
  });

  it('fallback engine respects search options', async () => {
    const { engine } = await createFaissEngine(artifact, mockProvider());

    const results = await engine.search('test', { cluster: 'core' });
    expect(results.every((r) => r.cluster === 'core')).toBe(true);
  });

  it('fallback engine respects limit option', async () => {
    const { engine } = await createFaissEngine(artifact, mockProvider());

    const results = await engine.search('test', { limit: 1 });
    expect(results.length).toBe(1);
  });

  it('fallback engine respects filterUnit predicate (AF-017/AF-018-M1)', async () => {
    const { engine } = await createFaissEngine(artifact, mockProvider());

    const results = await engine.search('test', {
      filterUnit: (unit) => unit.nodeId !== 'node-a',
    });
    expect(results.map((r) => r.nodeId)).not.toContain('node-a');
  });

  it('throws when faiss-node is missing and fallback is disabled', async () => {
    await expect(
      createFaissEngine(artifact, mockProvider(), { fallback: false }),
    ).rejects.toThrow('faiss-node is not installed');
  });

  it('explicit fallback: true works the same as default', async () => {
    const result = await createFaissEngine(artifact, mockProvider(), { fallback: true });
    expect(result.accelerated).toBe(false);
    expect(result.engine).toBeDefined();
  });
});
