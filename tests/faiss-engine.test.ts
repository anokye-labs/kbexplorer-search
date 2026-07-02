import { describe, it, expect } from 'vitest';
import { createFaissEngine } from '../src/faiss-engine.js';
import type { FaissModule } from '../src/faiss-engine.js';
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

/**
 * Test double for the `faiss-node` loader that simulates the module being
 * unavailable (not installed, or no prebuilt binary for the platform) —
 * mirrors what `import('faiss-node')` throws in that situation, without
 * depending on whatever is actually installed in the environment running
 * the tests.
 */
function unavailableLoader(): Promise<FaissModule> {
  return Promise.reject(new Error('faiss-node not installed (test double)'));
}

/**
 * Test double for the `faiss-node` loader that simulates the module being
 * present. `MockIndexFlatIP` is a minimal brute-force inner-product index —
 * enough to exercise the real accelerated code path in faiss-engine.ts
 * (index construction, `search()`, and `-1`-padded unfilled slots) without
 * a native dependency.
 */
function availableLoader(): Promise<FaissModule> {
  class MockIndexFlatIP {
    private vectors: number[][] = [];

    constructor(private dimensions: number) {}

    add(vector: number[]): void {
      this.vectors.push(vector);
    }

    ntotal(): number {
      return this.vectors.length;
    }

    search(query: number[], k: number): { distances: number[]; labels: number[] } {
      const scored = this.vectors.map((vector, index) => ({
        index,
        score: vector.reduce((sum, x, i) => sum + x * query[i], 0),
      }));
      scored.sort((a, b) => b.score - a.score);

      const top = scored.slice(0, k);
      const labels = top.map((entry) => entry.index);
      const distances = top.map((entry) => entry.score);

      // FAISS pads unfilled slots with label -1 when k > ntotal.
      while (labels.length < k) {
        labels.push(-1);
        distances.push(0);
      }

      return { distances, labels };
    }
  }

  return Promise.resolve({ IndexFlatIP: MockIndexFlatIP });
}

describe('createFaissEngine', () => {
  describe('fallback path (faiss-node unavailable)', () => {
    it('falls back to pure-JS cosine when faiss-node is not installed (default)', async () => {
      const result = await createFaissEngine(artifact, mockProvider(), {
        loadFaiss: unavailableLoader,
      });
      expect(result.accelerated).toBe(false);
      expect(result.engine).toBeDefined();
      expect(result.engine.search).toBeTypeOf('function');
    });

    it('fallback engine returns valid search results', async () => {
      const { engine, accelerated } = await createFaissEngine(artifact, mockProvider(), {
        loadFaiss: unavailableLoader,
      });
      expect(accelerated).toBe(false);

      const results = await engine.search('test query');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toHaveProperty('nodeId');
      expect(results[0]).toHaveProperty('score');
      expect(results[0]).toHaveProperty('snippet');
    });

    it('fallback engine respects search options', async () => {
      const { engine } = await createFaissEngine(artifact, mockProvider(), {
        loadFaiss: unavailableLoader,
      });

      const results = await engine.search('test', { cluster: 'core' });
      expect(results.every((r) => r.cluster === 'core')).toBe(true);
    });

    it('fallback engine respects limit option', async () => {
      const { engine } = await createFaissEngine(artifact, mockProvider(), {
        loadFaiss: unavailableLoader,
      });

      const results = await engine.search('test', { limit: 1 });
      expect(results.length).toBe(1);
    });

    it('fallback engine respects filterUnit predicate (AF-017/AF-018-M1)', async () => {
      const { engine } = await createFaissEngine(artifact, mockProvider(), {
        loadFaiss: unavailableLoader,
      });

      const results = await engine.search('test', {
        filterUnit: (unit) => unit.nodeId !== 'node-a',
      });
      expect(results.map((r) => r.nodeId)).not.toContain('node-a');
    });

    it('throws when faiss-node is missing and fallback is disabled', async () => {
      await expect(
        createFaissEngine(artifact, mockProvider(), {
          fallback: false,
          loadFaiss: unavailableLoader,
        }),
      ).rejects.toThrow('faiss-node is not installed');
    });

    it('explicit fallback: true works the same as default', async () => {
      const result = await createFaissEngine(artifact, mockProvider(), {
        fallback: true,
        loadFaiss: unavailableLoader,
      });
      expect(result.accelerated).toBe(false);
      expect(result.engine).toBeDefined();
    });
  });

  describe('accelerated path (faiss-node available)', () => {
    it('uses the FAISS-backed engine when faiss-node loads successfully', async () => {
      const result = await createFaissEngine(artifact, mockProvider(), {
        loadFaiss: availableLoader,
      });
      expect(result.accelerated).toBe(true);
      expect(result.engine).toBeDefined();
      expect(result.engine.search).toBeTypeOf('function');
    });

    it('accelerated engine returns valid, correctly ranked search results', async () => {
      const { engine, accelerated } = await createFaissEngine(artifact, mockProvider(), {
        loadFaiss: availableLoader,
      });
      expect(accelerated).toBe(true);

      // mockProvider always embeds queries as [1, 0, 0], which is an exact
      // match for node-a's vector and orthogonal to node-b's — so node-a
      // must rank first through the real FAISS search/build-results path.
      const results = await engine.search('test query');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].nodeId).toBe('node-a');
      expect(results[0]).toHaveProperty('score');
      expect(results[0]).toHaveProperty('snippet');
    });

    it('accelerated engine respects limit option', async () => {
      const { engine } = await createFaissEngine(artifact, mockProvider(), {
        loadFaiss: availableLoader,
      });

      const results = await engine.search('test', { limit: 1 });
      expect(results.length).toBe(1);
    });

    it('accelerated engine respects filterUnit predicate (AF-017/AF-018-M1)', async () => {
      const { engine } = await createFaissEngine(artifact, mockProvider(), {
        loadFaiss: availableLoader,
      });

      const results = await engine.search('test', {
        filterUnit: (unit) => unit.nodeId !== 'node-a',
      });
      expect(results.map((r) => r.nodeId)).not.toContain('node-a');
    });
  });
});
