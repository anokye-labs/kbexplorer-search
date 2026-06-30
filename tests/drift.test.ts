import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDrift } from '../src/drift.js';
import { writeArtifacts, computeContentHash } from '../src/artifacts.js';
import { extractSearchUnits } from '../src/extract.js';
import type { KBGraph } from '../src/kbexplorer-types.js';

function makeGraph(rawContents: Record<string, string>): KBGraph {
  return {
    nodes: Object.entries(rawContents).map(([id, rawContent]) => ({
      id,
      title: id,
      cluster: 'default',
      content: '',
      rawContent,
      connections: [],
      source: { type: 'authored' as const, file: `content/${id}.md` },
    })),
    edges: [],
    clusters: [{ id: 'default', name: 'Default', color: '#ccc' }],
    related: {},
  };
}

function writeGraphArtifacts(dir: string, graph: KBGraph): void {
  const units = extractSearchUnits(graph);
  const hash = computeContentHash(graph);
  // Fake vectors (drift check doesn't compare vectors)
  const vectors = units.map((u) => ({
    unitId: u.unitId,
    vector: [0.1, 0.2, 0.3],
    model: 'test',
    dimensions: 3,
  }));
  const config = {
    embedding: { provider: 'test', model: 'test', dimensions: 3 },
    artifacts: { dir },
  };
  writeArtifacts(dir, units, vectors, config, hash);
}

describe('checkDrift', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kbdrift-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns fresh=true when artifacts match the graph', () => {
    const graph = makeGraph({ a: 'Content A', b: 'Content B' });
    writeGraphArtifacts(dir, graph);

    const result = checkDrift(dir, graph);
    expect(result.fresh).toBe(true);
    expect(result.missingUnits).toEqual([]);
    expect(result.extraUnits).toEqual([]);
    expect(result.staleUnits).toEqual([]);
    expect(result.contentHashMatch).toBe(true);
  });

  it('detects missing units when a node is added', () => {
    const originalGraph = makeGraph({ a: 'Content A' });
    writeGraphArtifacts(dir, originalGraph);

    const updatedGraph = makeGraph({ a: 'Content A', b: 'Content B' });
    const result = checkDrift(dir, updatedGraph);

    expect(result.fresh).toBe(false);
    expect(result.missingUnits).toContain('b');
    expect(result.contentHashMatch).toBe(false);
  });

  it('detects stale units when content changes', () => {
    const originalGraph = makeGraph({ a: 'Original content' });
    writeGraphArtifacts(dir, originalGraph);

    const updatedGraph = makeGraph({ a: 'Modified content' });
    const result = checkDrift(dir, updatedGraph);

    expect(result.fresh).toBe(false);
    expect(result.staleUnits).toContain('a');
  });

  it('detects extra units when a node is removed', () => {
    const originalGraph = makeGraph({ a: 'Content A', b: 'Content B' });
    writeGraphArtifacts(dir, originalGraph);

    const updatedGraph = makeGraph({ a: 'Content A' });
    const result = checkDrift(dir, updatedGraph);

    expect(result.fresh).toBe(false);
    expect(result.extraUnits).toContain('b');
  });

  it('returns fresh=false when no artifacts exist', () => {
    const graph = makeGraph({ a: 'Content' });
    const result = checkDrift('/nonexistent', graph);

    expect(result.fresh).toBe(false);
    expect(result.contentHashMatch).toBe(false);
  });

  it('stays fresh when access-excluded nodes are absent from the index', () => {
    // Build artifacts with default exclusion: the restricted node is omitted.
    const graph: KBGraph = {
      ...makeGraph({ a: 'Content A' }),
      nodes: [
        ...makeGraph({ a: 'Content A' }).nodes,
        {
          id: 'sec',
          title: 'sec',
          cluster: 'default',
          content: '',
          rawContent: 'restricted content',
          connections: [],
          source: { type: 'authored' as const, file: 'content/sec.md' },
          access: { classification: 'restricted' },
        },
      ],
    };

    const units = extractSearchUnits(graph);
    const hash = computeContentHash(graph);
    const vectors = units.map((u) => ({
      unitId: u.unitId,
      vector: [0.1, 0.2, 0.3],
      model: 'test',
      dimensions: 3,
    }));
    writeArtifacts(
      dir,
      units,
      vectors,
      { embedding: { provider: 'test', model: 'test', dimensions: 3 }, artifacts: { dir } },
      hash,
    );

    const result = checkDrift(dir, graph);
    expect(result.fresh).toBe(true);
    expect(result.missingUnits).toEqual([]);
    expect(units.map((u) => u.unitId)).not.toContain('sec');
  });
});
