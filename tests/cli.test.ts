import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseServeArgs, startServe } from '../src/cli.js';
import { writeArtifacts, writeLexicalArtifacts } from '../src/artifacts.js';
import { buildLexicalIndex } from '../src/providers/lexical.js';
import type { EmbeddingProvider } from '../src/providers/interface.js';
import type { SearchUnit, EmbeddingVector, SearchConfig } from '../src/types.js';

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

const config: SearchConfig = {
  embedding: { provider: 'mock', model: 'mock-model', dimensions: 3 },
  artifacts: { dir: '.search' },
};

describe('parseServeArgs', () => {
  it('applies defaults', () => {
    const o = parseServeArgs([]);
    expect(o.dir).toBe('.search');
    expect(o.port).toBe(7700);
    expect(o.host).toBe('127.0.0.1');
    expect(o.provider).toBe('openai');
    expect(o.help).toBe(false);
  });

  it('parses flags in both --flag value and --flag=value forms', () => {
    const o = parseServeArgs([
      '--dir', '.idx', '--port=0', '--host', '0.0.0.0',
      '--provider=openai', '--model', 'text-embedding-3-large', '--dimensions=256',
    ]);
    expect(o.dir).toBe('.idx');
    expect(o.port).toBe(0);
    expect(o.host).toBe('0.0.0.0');
    expect(o.model).toBe('text-embedding-3-large');
    expect(o.dimensions).toBe(256);
  });

  it('recognizes --help', () => {
    expect(parseServeArgs(['--help']).help).toBe(true);
    expect(parseServeArgs(['-h']).help).toBe(true);
  });
});

describe('startServe', () => {
  const dirs: string[] = [];
  function tmpArtifactDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kbx-search-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it('throws a helpful error when no artifacts exist', async () => {
    const dir = tmpArtifactDir();
    await expect(
      startServe({ dir, port: 0, host: '127.0.0.1', provider: 'openai', help: false }),
    ).rejects.toThrow(/No search artifacts found/);
  });

  it('loads artifacts and serves /health and graph-ranked /search', async () => {
    const dir = tmpArtifactDir();
    writeArtifacts(dir, units, vectors, config, 'testhash');

    const { server, port, artifact } = await startServe(
      { dir, port: 0, host: '127.0.0.1', provider: 'mock', help: false },
      { resolveProvider: () => mockProvider() },
    );
    try {
      expect(artifact.meta.unitCount).toBe(2);

      const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
      expect(health.status).toBe('ok');
      expect(health.unitCount).toBe(2);

      const search = await fetch(`http://127.0.0.1:${port}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'audit', limit: 1, graphRanking: true }),
      }).then((r) => r.json());
      expect(search.results[0].nodeId).toBe('node-a');
      expect(search.suggestions.map((s: { nodeId: string }) => s.nodeId)).toContain('node-b');
    } finally {
      await server.stop();
    }
  });

  it('serves a lexical-provider (BM25) search end-to-end without 500ing', async () => {
    // The headline zero-credential path: `serve --provider lexical`. The
    // cosine engine calls provider.embed(), which LexicalProvider throws on by
    // design — so serve must select the BM25 engine for a lexical provider.
    // Uses the real provider registry (no creds, no network, no mock).
    const dir = tmpArtifactDir();
    const index = buildLexicalIndex(units);
    writeLexicalArtifacts(dir, units, index, 'testhash');

    const { server, port } = await startServe({
      dir,
      port: 0,
      host: '127.0.0.1',
      provider: 'lexical',
      help: false,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'audit validation', limit: 5 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results.length).toBeGreaterThan(0);
      expect(body.results[0].nodeId).toBe('node-a');
    } finally {
      await server.stop();
    }
  });

  it('defaults the query model/dimensions to the indexed values', async () => {
    const dir = tmpArtifactDir();
    writeArtifacts(dir, units, vectors, config, 'testhash');

    const seen: Array<{ model: string; dimensions?: number }> = [];
    const { server } = await startServe(
      { dir, port: 0, host: '127.0.0.1', provider: 'mock', help: false },
      {
        resolveProvider: (_name, cfg) => {
          seen.push(cfg);
          return mockProvider();
        },
      },
    );
    await server.stop();
    expect(seen[0].model).toBe('mock-model');
    expect(seen[0].dimensions).toBe(3);
  });
});
