import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeArtifacts,
  readArtifacts,
  computeContentHash,
  canonicalStringify,
} from '../src/artifacts.js';
import type { SearchUnit, EmbeddingVector } from '../src/types.js';
import type { KBGraph } from '../src/kbexplorer-types.js';

const sampleUnits: SearchUnit[] = [
  {
    unitId: 'b-node',
    nodeId: 'b-node',
    chunkIndex: 0,
    text: 'Content B',
    title: 'B Node',
    cluster: 'default',
    connections: ['a-node'],
    metadata: {},
  },
  {
    unitId: 'a-node',
    nodeId: 'a-node',
    chunkIndex: 0,
    text: 'Content A',
    title: 'A Node',
    cluster: 'default',
    connections: ['b-node'],
    metadata: {},
  },
];

const sampleVectors: EmbeddingVector[] = [
  { unitId: 'b-node', vector: [0.1, 0.2, 0.3], model: 'test', dimensions: 3 },
  { unitId: 'a-node', vector: [0.4, 0.5, 0.6], model: 'test', dimensions: 3 },
];

const sampleConfig = {
  embedding: { provider: 'test', model: 'test-model', dimensions: 3 },
  artifacts: { dir: '' },
};

describe('artifacts', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kbsearch-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('write + read round-trip returns identical data', () => {
    writeArtifacts(dir, sampleUnits, sampleVectors, sampleConfig, 'abc123');
    const artifact = readArtifacts(dir);

    expect(artifact).not.toBeNull();
    expect(artifact!.meta.model).toBe('test-model');
    expect(artifact!.meta.unitCount).toBe(2);
    expect(artifact!.meta.contentHash).toBe('abc123');
    expect(artifact!.units).toHaveLength(2);
    expect(artifact!.vectors).toHaveLength(2);
  });

  it('produces byte-identical files on two writes of the same data', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'kbsearch-test2-'));
    try {
      writeArtifacts(dir, sampleUnits, sampleVectors, sampleConfig, 'hash1');
      writeArtifacts(dir2, sampleUnits, sampleVectors, sampleConfig, 'hash1');

      for (const file of ['index-meta.json', 'units.json', 'vectors.json']) {
        const a = readFileSync(join(dir, file), 'utf8');
        const b = readFileSync(join(dir2, file), 'utf8');
        expect(a).toBe(b);
      }
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('sorts units and vectors by unitId regardless of input order', () => {
    writeArtifacts(dir, sampleUnits, sampleVectors, sampleConfig, 'hash');
    const artifact = readArtifacts(dir)!;

    // Units should be sorted: a-node before b-node
    expect(artifact.units[0].unitId).toBe('a-node');
    expect(artifact.units[1].unitId).toBe('b-node');
    expect(artifact.vectors[0].unitId).toBe('a-node');
    expect(artifact.vectors[1].unitId).toBe('b-node');
  });

  it('readArtifacts returns null for missing directory', () => {
    expect(readArtifacts('/nonexistent/path')).toBeNull();
  });

  it('index-meta.json contains correct unit count and model', () => {
    writeArtifacts(dir, sampleUnits, sampleVectors, sampleConfig, 'hash');
    const meta = JSON.parse(readFileSync(join(dir, 'index-meta.json'), 'utf8'));
    expect(meta.unitCount).toBe(2);
    expect(meta.model).toBe('test-model');
    expect(meta.dimensions).toBe(3);
    expect(meta.version).toBe(1);
  });
});

describe('computeContentHash', () => {
  it('returns the same hash for the same graph', () => {
    const graph: KBGraph = {
      nodes: [
        {
          id: 'a', title: 'A', cluster: 'c1', content: '', rawContent: 'text',
          connections: [], source: { type: 'authored', file: 'a.md' },
        },
      ],
      edges: [],
      clusters: [{ id: 'c1', name: 'C1', color: '#000' }],
      related: {},
    };

    expect(computeContentHash(graph)).toBe(computeContentHash(graph));
  });

  it('produces different hash when content changes', () => {
    const graph1: KBGraph = {
      nodes: [
        {
          id: 'a', title: 'A', cluster: 'c1', content: '', rawContent: 'original',
          connections: [], source: { type: 'authored', file: 'a.md' },
        },
      ],
      edges: [],
      clusters: [{ id: 'c1', name: 'C1', color: '#000' }],
      related: {},
    };
    const graph2: KBGraph = {
      ...graph1,
      nodes: [
        { ...graph1.nodes[0], rawContent: 'modified' },
      ],
    };

    expect(computeContentHash(graph1)).not.toBe(computeContentHash(graph2));
  });
});

describe('canonicalStringify', () => {
  it('sorts object keys', () => {
    const result = canonicalStringify({ z: 1, a: 2, m: 3 });
    expect(result).toBe('{\n  "a": 2,\n  "m": 3,\n  "z": 1\n}\n');
  });

  it('ends with trailing newline', () => {
    expect(canonicalStringify({ a: 1 })).toMatch(/\n$/);
  });
});
