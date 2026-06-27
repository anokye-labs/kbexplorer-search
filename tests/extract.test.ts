import { describe, it, expect } from 'vitest';
import { extractSearchUnits } from '../src/extract.js';
import type { KBGraph, KBNode, KBEdge, Cluster } from '../src/kbexplorer-types.js';

function makeNode(overrides: Partial<KBNode> & { id: string }): KBNode {
  return {
    title: overrides.id,
    cluster: 'default',
    content: '',
    rawContent: '',
    connections: [],
    source: { type: 'authored', file: `content/${overrides.id}.md` },
    ...overrides,
  };
}

function makeEdge(from: string, to: string, weight = 1): KBEdge {
  return {
    from,
    to,
    type: 'references',
    description: `${from} -> ${to}`,
    source: 'inline',
    weight,
  };
}

const defaultClusters: Cluster[] = [
  { id: 'default', name: 'Default', color: '#ccc' },
  { id: 'engine', name: 'Engine', color: '#f00' },
];

function makeGraph(
  nodes: KBNode[],
  edges: KBEdge[] = [],
  clusters: Cluster[] = defaultClusters,
): KBGraph {
  return { nodes, edges, clusters, related: {} };
}

describe('extractSearchUnits', () => {
  it('returns SearchUnits for nodes with rawContent', () => {
    const graph = makeGraph([
      makeNode({ id: 'a', title: 'Node A', rawContent: 'Content of node A' }),
      makeNode({ id: 'b', title: 'Node B', rawContent: 'Content of node B' }),
      makeNode({ id: 'c', title: 'Node C', rawContent: '' }),
    ]);

    const units = extractSearchUnits(graph);
    expect(units).toHaveLength(2);
    expect(units.map((u) => u.nodeId)).toEqual(['a', 'b']);
  });

  it('produces correct nodeId and chunkIndex for single-chunk nodes', () => {
    const graph = makeGraph([
      makeNode({ id: 'test', title: 'Test', rawContent: 'Short content' }),
    ]);

    const [unit] = extractSearchUnits(graph);
    expect(unit.nodeId).toBe('test');
    expect(unit.chunkIndex).toBe(0);
    expect(unit.unitId).toBe('test');
  });

  it('chunks long nodes into multiple SearchUnits', () => {
    const longContent = Array.from({ length: 200 }, (_, i) =>
      `## Section ${i}\n\nThis is paragraph ${i} with enough words to count as tokens.`
    ).join('\n\n');

    const graph = makeGraph([
      makeNode({ id: 'long', title: 'Long Node', rawContent: longContent }),
    ]);

    const units = extractSearchUnits(graph, { maxTokens: 100, overlap: 10 });
    expect(units.length).toBeGreaterThan(1);
    expect(units.every((u) => u.nodeId === 'long')).toBe(true);
    expect(units[0].unitId).toBe('long#0');
    expect(units[1].unitId).toBe('long#1');
    expect(units[0].chunkIndex).toBe(0);
    expect(units[1].chunkIndex).toBe(1);
  });

  it('populates connections from graph edges', () => {
    const graph = makeGraph(
      [
        makeNode({ id: 'a', title: 'A', rawContent: 'Content A' }),
        makeNode({ id: 'b', title: 'B', rawContent: 'Content B' }),
        makeNode({ id: 'c', title: 'C', rawContent: 'Content C' }),
      ],
      [makeEdge('a', 'b'), makeEdge('a', 'c')],
    );

    const units = extractSearchUnits(graph);
    const unitA = units.find((u) => u.nodeId === 'a')!;
    expect(unitA.connections).toEqual(['b', 'c']);
  });

  it('is deterministic — two runs produce identical output', () => {
    const graph = makeGraph(
      [
        makeNode({ id: 'z', title: 'Z', rawContent: 'Content Z' }),
        makeNode({ id: 'a', title: 'A', rawContent: 'Content A' }),
        makeNode({ id: 'm', title: 'M', rawContent: 'Content M' }),
      ],
      [makeEdge('z', 'a'), makeEdge('a', 'm')],
    );

    const run1 = extractSearchUnits(graph);
    const run2 = extractSearchUnits(graph);
    expect(JSON.stringify(run1)).toBe(JSON.stringify(run2));
  });

  it('includes graph context in metadata', () => {
    const graph = makeGraph(
      [
        makeNode({ id: 'parent', title: 'Parent Node', rawContent: 'Parent content' }),
        makeNode({ id: 'child', title: 'Child Node', rawContent: 'Child content', parent: 'parent' }),
      ],
      [makeEdge('parent', 'child', 5)],
    );

    const units = extractSearchUnits(graph);
    const child = units.find((u) => u.nodeId === 'child')!;
    expect(child.parentId).toBe('parent');
    expect(child.metadata['hierarchyPath']).toEqual(['Parent Node']);
    expect(child.metadata['neighborTitles']).toEqual(['Parent Node']);
  });

  it('prepends context header to SearchUnit text', () => {
    const graph = makeGraph(
      [
        makeNode({
          id: 'test',
          title: 'Test Node',
          cluster: 'engine',
          rawContent: 'Body text here',
        }),
      ],
      [],
      defaultClusters,
    );

    const [unit] = extractSearchUnits(graph);
    expect(unit.text).toContain('Title: Test Node');
    expect(unit.text).toContain('Cluster: Engine');
    expect(unit.text).toContain('Body text here');
  });

  it('resolves clusterName from graph clusters', () => {
    const graph = makeGraph(
      [
        makeNode({
          id: 'test',
          title: 'Test',
          cluster: 'engine',
          rawContent: 'Content',
        }),
      ],
      [],
      [{ id: 'engine', name: 'Engine Core', color: '#f00' }],
    );

    const [unit] = extractSearchUnits(graph);
    expect(unit.metadata['clusterName']).toBe('Engine Core');
  });

  it('preserves entityType and identity from KBNode', () => {
    const graph = makeGraph([
      makeNode({
        id: 'person-ada',
        title: 'Ada',
        rawContent: 'Ada bio',
        entityType: 'person',
        identity: 'kg://person/ada',
      }),
    ]);

    const [unit] = extractSearchUnits(graph);
    expect(unit.entityType).toBe('person');
    expect(unit.identity).toBe('kg://person/ada');
  });

  it('extracts source path from NodeSource', () => {
    const graph = makeGraph([
      makeNode({
        id: 'authored',
        title: 'Authored',
        rawContent: 'Content',
        source: { type: 'authored', file: 'content/test.md' },
      }),
    ]);

    const [unit] = extractSearchUnits(graph);
    expect(unit.path).toBe('content/test.md');
  });
});
