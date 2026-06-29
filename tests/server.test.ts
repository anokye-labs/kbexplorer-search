import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSearchServer } from '../src/server.js';
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

describe('search server', () => {
  let port: number;
  const srv = createSearchServer(artifact, mockProvider(), { port: 0 });

  beforeAll(async () => {
    port = await srv.start();
  });

  afterAll(async () => {
    await srv.stop();
  });

  it('GET /health returns ok with unit count', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.unitCount).toBe(2);
    expect(body.model).toBe('mock-model');
  });

  it('GET /stats returns index metadata', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/stats`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.unitCount).toBe(2);
    expect(body.dimensions).toBe(3);
    expect(body.contentHash).toBe('testhash');
  });

  it('POST /search returns ranked results', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'audit validation', limit: 2 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toHaveProperty('nodeId');
    expect(body.results[0]).toHaveProperty('score');
    expect(body.results[0]).toHaveProperty('snippet');
    // Stable contract: suggestions is always present (empty without graphRanking).
    expect(body.suggestions).toEqual([]);
  });

  it('POST /search with graphRanking returns graph suggestions', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'audit validation', limit: 1, graphRanking: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].nodeId).toBe('node-a');
    // node-b is a 1-hop neighbor of node-a and not in the result set,
    // so graph ranking surfaces it as a related suggestion.
    expect(Array.isArray(body.suggestions)).toBe(true);
    expect(body.suggestions.map((s: { nodeId: string }) => s.nodeId)).toContain('node-b');
    expect(body.suggestions[0]).toHaveProperty('reason');
  });

  it('POST /search with cluster filter', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test', cluster: 'core' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.every((r: { cluster: string }) => r.cluster === 'core')).toBe(true);
  });

  it('POST /search returns 400 for missing query', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('query');
  });

  it('POST /search returns 400 for invalid JSON', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('GET /unknown returns 404', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/unknown`);
    expect(res.status).toBe(404);
  });

  it('OPTIONS returns 204 (CORS preflight)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/search`, {
      method: 'OPTIONS',
    });
    expect(res.status).toBe(204);
  });
});
