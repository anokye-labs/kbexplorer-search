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

describe('extractSearchUnits — access labels (issue #9)', () => {
  it('excludes restricted and unknown nodes from the index by default', () => {
    const graph = makeGraph([
      makeNode({ id: 'pub', title: 'Public', rawContent: 'public body' }),
      makeNode({
        id: 'sec',
        title: 'Secret',
        rawContent: 'secret body',
        access: { classification: 'restricted' },
      }),
      makeNode({
        id: 'unk',
        title: 'Unknown',
        rawContent: 'unknown body',
        access: { classification: 'unknown' },
      }),
    ]);

    const units = extractSearchUnits(graph);
    expect(units.map((u) => u.nodeId)).toEqual(['pub']);
  });

  it('excludes private-visibility nodes by default', () => {
    const graph = makeGraph([
      makeNode({ id: 'a', title: 'A', rawContent: 'a body' }),
      makeNode({
        id: 'b',
        title: 'B',
        rawContent: 'b body',
        access: { classification: 'public', visibility: 'private' },
      }),
    ]);

    const units = extractSearchUnits(graph);
    expect(units.map((u) => u.nodeId)).toEqual(['a']);
  });

  it('does not leak excluded titles or text into any unit', () => {
    const graph = makeGraph([
      makeNode({
        id: 'sec',
        title: 'Top Secret Title',
        rawContent: 'classified body text',
        access: { classification: 'restricted' },
      }),
    ]);

    const serialized = JSON.stringify(extractSearchUnits(graph));
    expect(serialized).not.toContain('Top Secret Title');
    expect(serialized).not.toContain('classified body text');
  });

  it('indexes public/internal and unlabeled content; excludes confidential', () => {
    const graph = makeGraph([
      makeNode({ id: 'none', title: 'None', rawContent: 'x' }),
      makeNode({ id: 'pub', title: 'Pub', rawContent: 'x', access: { classification: 'public' } }),
      makeNode({ id: 'int', title: 'Int', rawContent: 'x', access: { classification: 'internal' } }),
      makeNode({ id: 'con', title: 'Con', rawContent: 'x', access: { classification: 'confidential' } }),
    ]);

    const units = extractSearchUnits(graph);
    expect(units.map((u) => u.nodeId)).toEqual(['int', 'none', 'pub']);
  });

  it('carries unit.access for every LABELED node, not just excluded-set matches (AF-017/AF-018-M1)', () => {
    // A host running in include-mode filtering (or auditing exclude-mode
    // output) needs every label present on the graph, including labels that
    // don't happen to match the exclusion criteria (e.g. `public`) — the
    // fix used to only carry `access` when the label made the node excluded.
    const graph = makeGraph([
      makeNode({ id: 'none', title: 'None', rawContent: 'x' }),
      makeNode({ id: 'pub', title: 'Pub', rawContent: 'x', access: { classification: 'public' } }),
      makeNode({ id: 'int', title: 'Int', rawContent: 'x', access: { classification: 'internal' } }),
    ]);

    const units = extractSearchUnits(graph);
    const none = units.find((u) => u.nodeId === 'none')!;
    const pub = units.find((u) => u.nodeId === 'pub')!;
    const int = units.find((u) => u.nodeId === 'int')!;

    // No label at all (issue #9's fails-open default): access stays undefined.
    expect(none.access).toBeUndefined();
    // Labeled but not excluded: the label is still carried (AF-017/AF-018-M1).
    expect(pub.access).toEqual({ classification: 'public' });
    expect(int.access).toEqual({ classification: 'internal' });
  });

  it('include mode indexes restricted units with their access label attached', () => {
    const graph = makeGraph([
      makeNode({ id: 'pub', title: 'Pub', rawContent: 'x' }),
      makeNode({
        id: 'sec',
        title: 'Sec',
        rawContent: 'x',
        access: { classification: 'restricted', labels: ['pii'] },
      }),
    ]);

    const units = extractSearchUnits(graph, undefined, { mode: 'include' });
    expect(units.map((u) => u.nodeId)).toEqual(['pub', 'sec']);
    const sec = units.find((u) => u.nodeId === 'sec');
    expect(sec?.access).toEqual({ classification: 'restricted', labels: ['pii'] });
    const pub = units.find((u) => u.nodeId === 'pub');
    expect(pub?.access).toBeUndefined();
  });

  it('exclusion is deterministic: byte-identical output across runs', () => {
    const build = () =>
      makeGraph([
        makeNode({ id: 'a', title: 'A', rawContent: 'a' }),
        makeNode({ id: 'b', title: 'B', rawContent: 'b', access: { classification: 'restricted' } }),
        makeNode({ id: 'c', title: 'C', rawContent: 'c', access: { visibility: 'private' } }),
      ]);

    const first = JSON.stringify(extractSearchUnits(build()));
    const second = JSON.stringify(extractSearchUnits(build()));
    expect(first).toBe(second);
  });
});

describe('extractSearchUnits — access-exclusion leak regression (AF-001 / #15 / #16)', () => {
  // The original suite only ever excluded an isolated node with no edges —
  // structurally incapable of catching a leak that only shows up once an
  // excluded node has a parent edge AND neighbor edges into public nodes.
  // This block builds exactly that shape: a restricted node sitting between
  // a public parent and a public child, with a further edge out to a public
  // neighbor, and asserts its title/id are unreachable from every angle:
  // embedded `text`, `connections[]`, `parentId`, and `metadata`.

  function buildLeakGraph(classification: 'restricted' | 'confidential' | 'unknown') {
    return makeGraph(
      [
        makeNode({ id: 'root', title: 'Root Node', rawContent: 'root body' }),
        makeNode({
          id: 'restricted-1',
          title: 'Top Secret Title',
          rawContent: 'classified body text',
          parent: 'root',
          access: { classification },
        }),
        makeNode({
          id: 'child-1',
          title: 'Public Child',
          rawContent: 'public child body',
          parent: 'restricted-1',
        }),
        makeNode({ id: 'neighbor-1', title: 'Neighbor Node', rawContent: 'neighbor body' }),
      ],
      [makeEdge('root', 'restricted-1'), makeEdge('restricted-1', 'neighbor-1', 5)],
    );
  }

  it.each(['restricted', 'confidential', 'unknown'] as const)(
    'excludes a %s node with parent+neighbor edges from every public unit\'s text/connections/parentId/metadata',
    (classification) => {
      const graph = buildLeakGraph(classification);
      const units = extractSearchUnits(graph);

      // The restricted node itself never gets a unit in default exclude mode.
      expect(units.map((u) => u.nodeId).sort()).toEqual(['child-1', 'neighbor-1', 'root']);

      // (a) No excluded title substring appears in any public unit's embedded text.
      for (const u of units) {
        expect(u.text).not.toContain('Top Secret Title');
        expect(u.text).not.toContain('classified body text');
      }

      // (b) No excluded id appears in any connections/parentId/metadata field.
      const serialized = JSON.stringify(units);
      expect(serialized).not.toContain('restricted-1');
      expect(serialized).not.toContain('Top Secret Title');
      expect(serialized).not.toContain('classified body text');

      const root = units.find((u) => u.nodeId === 'root')!;
      const child = units.find((u) => u.nodeId === 'child-1')!;
      const neighbor = units.find((u) => u.nodeId === 'neighbor-1')!;

      // root -> restricted-1 edge must not surface in root's connections.
      expect(root.connections).not.toContain('restricted-1');

      // restricted-1 -> neighbor-1 edge must not surface in neighbor's
      // connections, metadata.neighborTitles, or embedded "Related:" text.
      expect(neighbor.connections).not.toContain('restricted-1');
      expect(neighbor.metadata['neighborTitles']).not.toContain('Top Secret Title');

      // child-1's parent is the excluded node: parentId must not leak it,
      // and its hierarchy path must not name the restricted parent.
      expect(child.parentId).toBeUndefined();
      expect(child.metadata['hierarchyPath']).not.toContain('Top Secret Title');
    },
  );

  it('public child of a restricted parent: hierarchy path never names the restricted parent', () => {
    const graph = makeGraph(
      [
        makeNode({ id: 'grandparent', title: 'Grandparent Node', rawContent: 'gp body' }),
        makeNode({
          id: 'restricted-parent',
          title: 'Restricted Parent Title',
          rawContent: 'restricted parent body',
          parent: 'grandparent',
          access: { classification: 'restricted' },
        }),
        makeNode({
          id: 'public-child',
          title: 'Public Child',
          rawContent: 'public child body',
          parent: 'restricted-parent',
        }),
      ],
      [makeEdge('grandparent', 'restricted-parent'), makeEdge('restricted-parent', 'public-child')],
    );

    const units = extractSearchUnits(graph);
    const child = units.find((u) => u.nodeId === 'public-child')!;

    expect(child.parentId).toBeUndefined();
    expect(child.metadata['hierarchyPath']).not.toContain('Restricted Parent Title');
    expect(child.text).not.toContain('Restricted Parent Title');
    expect(JSON.stringify(units)).not.toContain('restricted-parent');
  });

  it('default exclude mode: unknown-classification handling matches isExcludedByAccess\'s actual contract', () => {
    // isExcludedByAccess treats an explicit `unknown` classification as
    // excluded (it's in DEFAULT_ACCESS_EXCLUSION.excludedClassifications),
    // while a node with NO access label at all is never excluded (fails
    // open — a missing label is ordinary content, not "unknown").
    const graph = makeGraph([
      makeNode({ id: 'unlabeled', title: 'Unlabeled', rawContent: 'x' }),
      makeNode({
        id: 'unknown-1',
        title: 'Unknown Classification Title',
        rawContent: 'x',
        access: { classification: 'unknown' },
      }),
    ]);

    const units = extractSearchUnits(graph);
    expect(units.map((u) => u.nodeId)).toEqual(['unlabeled']);
  });
});
