import { describe, it, expect } from 'vitest';
import { generateEmbeddings, hashText } from '../src/embed.js';
import type { EmbeddingProvider } from '../src/providers/interface.js';
import type { SearchUnit, EmbeddingArtifact } from '../src/types.js';

function mockProvider(): EmbeddingProvider & { embedCalls: string[][] } {
  const calls: string[][] = [];
  return {
    name: 'mock',
    model: 'mock-model',
    dimensions: 3,
    embedCalls: calls,
    async embed(texts: string[]): Promise<number[][]> {
      calls.push([...texts]);
      return texts.map((_, i) => [i * 0.1, i * 0.2, i * 0.3]);
    },
  };
}

function makeUnit(id: string, text: string): SearchUnit {
  return {
    unitId: id,
    nodeId: id,
    chunkIndex: 0,
    text,
    title: id,
    cluster: 'default',
    connections: [],
    metadata: {},
  };
}

describe('generateEmbeddings', () => {
  it('batches units into correct-sized calls', async () => {
    const units = Array.from({ length: 150 }, (_, i) =>
      makeUnit(`unit-${i}`, `Text ${i}`)
    );
    const provider = mockProvider();

    await generateEmbeddings(units, provider, { batchSize: 100, delayMs: 0 });

    expect(provider.embedCalls).toHaveLength(2);
    expect(provider.embedCalls[0]).toHaveLength(100);
    expect(provider.embedCalls[1]).toHaveLength(50);
  });

  it('reuses cached vectors from previous artifact', async () => {
    const units = [
      makeUnit('a', 'Same text'),
      makeUnit('b', 'Different text'),
    ];

    const prevArtifact: EmbeddingArtifact = {
      meta: {
        version: 1,
        contentHash: 'old',
        model: 'mock-model',
        dimensions: 3,
        unitCount: 2,
      },
      units: [
        makeUnit('a', 'Same text'),
        makeUnit('b', 'Old text'),
      ],
      vectors: [
        { unitId: 'a', vector: [0.9, 0.8, 0.7], model: 'mock-model', dimensions: 3 },
        { unitId: 'b', vector: [0.1, 0.2, 0.3], model: 'mock-model', dimensions: 3 },
      ],
    };

    const provider = mockProvider();
    const result = await generateEmbeddings(units, provider, {
      batchSize: 100,
      delayMs: 0,
      previousArtifact: prevArtifact,
    });

    // Only 'b' should have been embedded (text changed)
    expect(provider.embedCalls).toHaveLength(1);
    expect(provider.embedCalls[0]).toHaveLength(1);

    // 'a' should have its cached vector
    const vecA = result.find((v) => v.unitId === 'a')!;
    expect(vecA.vector).toEqual([0.9, 0.8, 0.7]);
  });

  it('skips all when nothing changed', async () => {
    const units = [makeUnit('a', 'Same text')];

    const prevArtifact: EmbeddingArtifact = {
      meta: { version: 1, contentHash: 'old', model: 'mock-model', dimensions: 3, unitCount: 1 },
      units: [makeUnit('a', 'Same text')],
      vectors: [
        { unitId: 'a', vector: [0.9, 0.8, 0.7], model: 'mock-model', dimensions: 3 },
      ],
    };

    const provider = mockProvider();
    await generateEmbeddings(units, provider, {
      delayMs: 0,
      previousArtifact: prevArtifact,
    });

    expect(provider.embedCalls).toHaveLength(0);
  });

  it('fires progress callback with correct counts', async () => {
    const units = [makeUnit('a', 'Text A'), makeUnit('b', 'Text B')];
    const provider = mockProvider();
    const progressCalls: Array<{ completed: number; total: number; cached: number; embedded: number }> = [];

    await generateEmbeddings(units, provider, {
      batchSize: 100,
      delayMs: 0,
      onProgress: (p) => progressCalls.push({ ...p }),
    });

    // Initial progress (0 cached) + after batch
    expect(progressCalls.length).toBeGreaterThanOrEqual(2);
    const last = progressCalls[progressCalls.length - 1];
    expect(last.completed).toBe(2);
    expect(last.total).toBe(2);
    expect(last.embedded).toBe(2);
  });
});

describe('hashText', () => {
  it('returns consistent SHA-256 hex', () => {
    const h1 = hashText('hello');
    const h2 = hashText('hello');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64); // SHA-256 hex
  });

  it('returns different hash for different text', () => {
    expect(hashText('a')).not.toBe(hashText('b'));
  });
});
