import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  tokenize,
  buildLexicalIndex,
  scoreLexicalQuery,
  createLexicalSearchEngine,
  LexicalProvider,
  LEXICAL_PROVIDER_NAME,
} from '../src/providers/lexical.js';
import { getProvider, listProviders } from '../src/providers/index.js';
import {
  writeLexicalArtifacts,
  readLexicalArtifacts,
  computeContentHash,
  canonicalStringify,
} from '../src/artifacts.js';
import { checkDrift } from '../src/drift.js';
import { extractSearchUnits } from '../src/extract.js';
import type { SearchUnit } from '../src/types.js';
import type { KBGraph } from '../src/kbexplorer-types.js';

function unit(overrides: Partial<SearchUnit> & { unitId: string; text: string }): SearchUnit {
  return {
    nodeId: overrides.unitId,
    chunkIndex: 0,
    title: overrides.unitId,
    cluster: 'default',
    connections: [],
    metadata: {},
    ...overrides,
  };
}

describe('tokenize', () => {
  it('lowercases and extracts alphanumeric runs', () => {
    expect(tokenize('Audit Validation: Checks Structural-Integrity!')).toEqual([
      'audit',
      'validation',
      'checks',
      'structural',
      'integrity',
    ]);
  });

  it('returns an empty array for text with no tokens', () => {
    expect(tokenize('   ---   ')).toEqual([]);
  });
});

describe('buildLexicalIndex', () => {
  const units: SearchUnit[] = [
    unit({ unitId: 'audit', text: 'Title: Audit\n\nAudit validation checks structural integrity' }),
    unit({ unitId: 'graph', text: 'Title: Graph\n\nGraph engine processes nodes and edges' }),
    unit({ unitId: 'readme', text: 'Title: README\n\nProject overview and getting started' }),
  ];

  it('is deterministic: two runs produce byte-identical JSON', () => {
    const first = canonicalStringify(buildLexicalIndex(units));
    const second = canonicalStringify(buildLexicalIndex(units));
    expect(first).toBe(second);
  });

  it('is order-independent: shuffled input produces the same index', () => {
    const shuffled = [units[2], units[0], units[1]];
    const a = canonicalStringify(buildLexicalIndex(units));
    const b = canonicalStringify(buildLexicalIndex(shuffled));
    expect(a).toBe(b);
  });

  it('records per-unit document length and corpus-wide average', () => {
    const index = buildLexicalIndex(units);
    expect(index.docCount).toBe(3);
    expect(index.docLengths['audit']).toBe(tokenize(units[0].text).length);
    const total = units.reduce((sum, u) => sum + tokenize(u.text).length, 0);
    expect(index.avgDocLength).toBeCloseTo(total / 3);
  });

  it('builds sorted postings per term', () => {
    const index = buildLexicalIndex(units);
    // "audit" appears only in the audit unit.
    expect(index.postings['audit']).toEqual([{ unitId: 'audit', termFrequency: 2 }]);
    // Postings lists are sorted by unitId.
    const terms = Object.keys(index.postings);
    expect(terms).toEqual([...terms].sort());
  });

  it('uses default BM25 parameters when none are given', () => {
    const index = buildLexicalIndex(units);
    expect(index.k1).toBe(1.2);
    expect(index.b).toBe(0.75);
  });

  it('honors custom k1/b parameters', () => {
    const index = buildLexicalIndex(units, { k1: 2, b: 0.5 });
    expect(index.k1).toBe(2);
    expect(index.b).toBe(0.5);
  });

  it('handles an empty corpus without dividing by zero', () => {
    const index = buildLexicalIndex([]);
    expect(index.docCount).toBe(0);
    expect(index.avgDocLength).toBe(0);
    expect(index.postings).toEqual({});
  });
});

describe('scoreLexicalQuery — relevance sanity', () => {
  const units: SearchUnit[] = [
    unit({ unitId: 'audit', text: 'Title: Audit\n\nAudit validation checks structural integrity of the graph' }),
    unit({ unitId: 'graph', text: 'Title: Graph\n\nGraph engine processes nodes and edges efficiently' }),
    unit({ unitId: 'readme', text: 'Title: README\n\nProject overview and getting started guide' }),
  ];
  const index = buildLexicalIndex(units);

  it('ranks the unit containing the query terms above unrelated units', () => {
    const scores = scoreLexicalQuery(index, 'audit validation');
    expect(scores.get('audit')).toBeGreaterThan(0);
    expect(scores.get('audit')).toBeGreaterThan(scores.get('readme') ?? 0);
    expect(scores.has('readme')).toBe(false); // no term overlap at all
  });

  it('returns no scores for a query with no matching terms', () => {
    const scores = scoreLexicalQuery(index, 'zzz nonexistent');
    expect(scores.size).toBe(0);
  });

  it('returns no scores for an empty query', () => {
    expect(scoreLexicalQuery(index, '').size).toBe(0);
  });

  it('gives higher score to a document mentioning the term more often (all else equal)', () => {
    const repeated: SearchUnit[] = [
      unit({ unitId: 'one', text: 'graph graph graph engine' }),
      unit({ unitId: 'two', text: 'graph engine' }),
    ];
    const repeatedIndex = buildLexicalIndex(repeated);
    const scores = scoreLexicalQuery(repeatedIndex, 'graph');
    expect(scores.get('one')!).toBeGreaterThan(scores.get('two')!);
  });
});

describe('createLexicalSearchEngine', () => {
  const units: SearchUnit[] = [
    unit({
      unitId: 'audit',
      text: 'Title: Audit\n\nAudit validation checks structural integrity',
      cluster: 'engine',
      connections: ['graph'],
    }),
    unit({
      unitId: 'graph',
      text: 'Title: Graph\n\nGraph engine processes nodes and edges',
      title: 'Graph Engine',
      cluster: 'engine',
      connections: ['audit'],
    }),
    unit({
      unitId: 'readme',
      text: 'Title: README\n\nProject overview and getting started',
      cluster: 'docs',
    }),
  ];
  const index = buildLexicalIndex(units);

  it('returns results ranked by BM25 score, best first', async () => {
    const engine = createLexicalSearchEngine(units, index);
    const results = await engine.search('audit validation');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].nodeId).toBe('audit');
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('respects cluster filter', async () => {
    const engine = createLexicalSearchEngine(units, index);
    const results = await engine.search('project overview', { cluster: 'docs' });
    expect(results.every((r) => r.cluster === 'docs')).toBe(true);
    expect(results.map((r) => r.nodeId)).toContain('readme');
  });

  it('respects minScore threshold', async () => {
    const engine = createLexicalSearchEngine(units, index);
    const results = await engine.search('audit validation', { minScore: 1e9 });
    expect(results).toEqual([]);
  });

  it('respects limit option', async () => {
    const engine = createLexicalSearchEngine(units, index);
    const results = await engine.search('graph engine audit project', { limit: 1 });
    expect(results).toHaveLength(1);
  });

  it('SearchResult has the same shape as the cosine engine', async () => {
    const engine = createLexicalSearchEngine(units, index);
    const [result] = await engine.search('audit');
    expect(result).toMatchObject({
      nodeId: 'audit',
      title: expect.any(String),
      cluster: 'engine',
      score: expect.any(Number),
      snippet: expect.any(String),
      chunkIndex: 0,
      connections: ['graph'],
      metadata: expect.any(Object),
    });
  });

  it('returns no results for a query with no matches', async () => {
    const engine = createLexicalSearchEngine(units, index);
    const results = await engine.search('zzz nonexistent');
    expect(results).toEqual([]);
  });
});

describe('LexicalProvider and provider registry', () => {
  it('is registered under "lexical" alongside "openai"', () => {
    const names = listProviders();
    expect(names).toContain('lexical');
    expect(names).toContain('openai');
  });

  it('getProvider("lexical", ...) resolves a LexicalProvider', () => {
    const provider = getProvider(LEXICAL_PROVIDER_NAME, { model: 'lexical-bm25' });
    expect(provider).toBeInstanceOf(LexicalProvider);
    expect(provider.name).toBe('lexical');
    expect(provider.dimensions).toBe(0);
  });

  it('requires no API key / network to construct', () => {
    // Must not throw even with no environment configured — zero-credential.
    expect(() => new LexicalProvider()).not.toThrow();
  });

  it('embed() rejects with a clear, actionable error rather than faking a vector', async () => {
    const provider = new LexicalProvider();
    await expect(provider.embed(['some text'])).rejects.toThrow(/buildLexicalIndex/);
  });
});

describe('end-to-end: extract -> index -> query', () => {
  const graph: KBGraph = {
    nodes: [
      {
        id: 'audit-doc',
        title: 'Audit Validation',
        cluster: 'engine',
        content: '',
        rawContent: 'Audit validation checks structural integrity of the knowledge graph.',
        connections: [{ to: 'graph-doc', type: 'references', description: 'relates to graph engine' }],
        source: { type: 'authored', file: 'content/audit.md' },
      },
      {
        id: 'graph-doc',
        title: 'Graph Engine',
        cluster: 'engine',
        content: '',
        rawContent: 'The graph engine processes nodes and edges to build the knowledge graph.',
        connections: [],
        source: { type: 'authored', file: 'content/graph.md' },
      },
      {
        id: 'readme-doc',
        title: 'README',
        cluster: 'docs',
        content: '',
        rawContent: 'Project overview and getting started guide for new contributors.',
        connections: [],
        source: { type: 'authored', file: 'content/readme.md' },
      },
    ],
    edges: [
      { from: 'audit-doc', to: 'graph-doc', type: 'references', description: 'relates to graph engine', source: 'inline', weight: 1 },
    ],
    clusters: [
      { id: 'engine', name: 'Engine', color: '#336699' },
      { id: 'docs', name: 'Docs', color: '#996633' },
    ],
    related: {},
  };

  it('serves a relevant result from a real extract -> index -> query pipeline', async () => {
    const units = extractSearchUnits(graph);
    const index = buildLexicalIndex(units);
    const engine = createLexicalSearchEngine(units, index);

    const results = await engine.search('audit validation integrity');
    expect(results[0].nodeId).toBe('audit-doc');
  });

  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kbsearch-lexical-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes and reads back the full lexical artifact set', () => {
    const units = extractSearchUnits(graph);
    const index = buildLexicalIndex(units);

    writeLexicalArtifacts(dir, units, index, 'content-hash-1');
    const artifact = readLexicalArtifacts(dir);

    expect(artifact).not.toBeNull();
    expect(artifact!.meta.providerType).toBe('lexical');
    expect(artifact!.meta.model).toBe('lexical-bm25');
    expect(artifact!.meta.dimensions).toBe(0);
    expect(artifact!.units).toHaveLength(units.length);
    expect(artifact!.index.docCount).toBe(units.length);
  });

  it('writes byte-identical artifacts across two builds of the same graph', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'kbsearch-lexical2-'));
    try {
      const unitsA = extractSearchUnits(graph);
      const indexA = buildLexicalIndex(unitsA);
      writeLexicalArtifacts(dir, unitsA, indexA, 'hash');

      const unitsB = extractSearchUnits(graph);
      const indexB = buildLexicalIndex(unitsB);
      writeLexicalArtifacts(dir2, unitsB, indexB, 'hash');

      for (const file of ['index-meta.json', 'units.json', 'vectors.json', 'lexical-index.json']) {
        const a = readFileSync(join(dir, file), 'utf8');
        const b = readFileSync(join(dir2, file), 'utf8');
        expect(a).toBe(b);
      }
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('passes the standard drift gate (search-index --check parity)', () => {
    const units = extractSearchUnits(graph);
    const index = buildLexicalIndex(units);
    const hash = computeContentHash(graph);

    writeLexicalArtifacts(dir, units, index, hash);

    const result = checkDrift(dir, graph);
    expect(result.fresh).toBe(true);
    expect(result.missingUnits).toEqual([]);
    expect(result.extraUnits).toEqual([]);
    expect(result.staleUnits).toEqual([]);
    expect(result.contentHashMatch).toBe(true);
  });
});
