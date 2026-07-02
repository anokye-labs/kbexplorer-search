/**
 * Zero-credential lexical (BM25) search provider (issue #11).
 *
 * Backs the kbexplorer-cli onboarding "local" search mode: no API key, no
 * network call, no embeddings. A deterministic inverted term index is built
 * from SearchUnit text and queried with BM25 — Okapi BM25, the standard
 * refinement of TF-IDF that saturates term-frequency contribution and
 * normalizes for document length.
 *
 * Two complementary pieces live here:
 *
 *  - {@link LexicalProvider}: registered in the provider registry as
 *    `'lexical'` (alongside `'openai'`) so it participates in provider
 *    discovery (`listProviders()` / `getProvider('lexical', ...)`).
 *  - {@link buildLexicalIndex} / {@link scoreLexicalQuery} /
 *    {@link createLexicalSearchEngine}: the actual BM25 index build and
 *    query path. BM25 needs corpus-wide statistics (document frequency,
 *    average document length) that must survive the process boundary
 *    between index build and query time — a stateless per-call
 *    `embed(texts)` cannot carry that state, so `LexicalProvider.embed()`
 *    intentionally throws rather than faking a dense-vector result; the real
 *    query path is `createLexicalSearchEngine`, built from the persisted
 *    {@link LexicalIndex} artifact (see `artifacts.ts`'s
 *    `writeLexicalArtifacts` / `readLexicalArtifacts`).
 *
 * Deterministic throughout: sorted terms, sorted postings, no timestamps, no
 * randomness — two builds of the same units produce byte-identical
 * `lexical-index.json`.
 */

import type { EmbeddingProvider } from './interface.js';
import type {
  LexicalIndex,
  LexicalPosting,
  SearchUnit,
  SearchResult,
  SearchOptions,
  SearchEngine,
} from '../types.js';
import { makeSnippet } from '../snippet.js';

/** Registry name this provider is registered under. */
export const LEXICAL_PROVIDER_NAME = 'lexical';

/** Default BM25 term-frequency saturation parameter. */
const DEFAULT_K1 = 1.2;
/** Default BM25 document-length normalization parameter. */
const DEFAULT_B = 0.75;

/** Tokens are runs of lowercase letters/digits — simple and deterministic. */
const TOKEN_PATTERN = /[a-z0-9]+/g;

/**
 * Tokenize text for lexical indexing/querying: lowercase, then extract
 * alphanumeric runs. Pure and deterministic (no locale-dependent behavior).
 */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(TOKEN_PATTERN) ?? [];
}

/** Options for {@link buildLexicalIndex}. */
export interface LexicalIndexOptions {
  /** BM25 term-frequency saturation parameter (default: 1.2). */
  k1?: number;
  /** BM25 document-length normalization parameter (default: 0.75). */
  b?: number;
}

/**
 * Build a deterministic BM25 term index from a set of SearchUnits.
 *
 * Output is stable regardless of input order: units are processed in
 * unitId order, terms are emitted in sorted order, and each term's postings
 * are sorted by unitId — so two builds of the same units produce
 * byte-identical {@link LexicalIndex} JSON.
 */
export function buildLexicalIndex(
  units: SearchUnit[],
  options?: LexicalIndexOptions,
): LexicalIndex {
  const k1 = options?.k1 ?? DEFAULT_K1;
  const b = options?.b ?? DEFAULT_B;

  const sortedUnits = [...units].sort((a, c) => a.unitId.localeCompare(c.unitId));

  const docLengths: Record<string, number> = {};
  const postingsByTerm = new Map<string, Map<string, number>>();

  for (const unit of sortedUnits) {
    const tokens = tokenize(unit.text);
    docLengths[unit.unitId] = tokens.length;

    const termCounts = new Map<string, number>();
    for (const token of tokens) {
      termCounts.set(token, (termCounts.get(token) ?? 0) + 1);
    }

    for (const [term, tf] of termCounts) {
      if (!postingsByTerm.has(term)) postingsByTerm.set(term, new Map());
      postingsByTerm.get(term)!.set(unit.unitId, tf);
    }
  }

  const docCount = sortedUnits.length;
  const totalLength = Object.values(docLengths).reduce((sum, len) => sum + len, 0);
  const avgDocLength = docCount > 0 ? totalLength / docCount : 0;

  const postings: Record<string, LexicalPosting[]> = {};
  for (const term of [...postingsByTerm.keys()].sort()) {
    const perUnit = postingsByTerm.get(term)!;
    postings[term] = [...perUnit.entries()]
      .sort((a, c) => a[0].localeCompare(c[0]))
      .map(([unitId, termFrequency]) => ({ unitId, termFrequency }));
  }

  return { version: 1, k1, b, docCount, avgDocLength, docLengths, postings };
}

/**
 * Score a query against a {@link LexicalIndex} using Okapi BM25.
 *
 * Returns a map of unitId -> BM25 score for every unit sharing at least one
 * query term (units with no overlap are simply absent — an implicit score of
 * zero). Pure function of (index, query); no I/O, no randomness.
 */
export function scoreLexicalQuery(
  index: LexicalIndex,
  query: string,
): Map<string, number> {
  const scores = new Map<string, number>();
  const queryTerms = new Set(tokenize(query));
  if (queryTerms.size === 0 || index.docCount === 0) return scores;

  for (const term of queryTerms) {
    const postings = index.postings[term];
    if (!postings || postings.length === 0) continue;

    const df = postings.length;
    // BM25 IDF with +1 smoothing: always non-negative, even when df > N/2.
    const idf = Math.log((index.docCount - df + 0.5) / (df + 0.5) + 1);

    for (const posting of postings) {
      const docLength = index.docLengths[posting.unitId] ?? 0;
      const lengthNorm =
        1 - index.b + index.b * (docLength / (index.avgDocLength || 1));
      const denom = posting.termFrequency + index.k1 * lengthNorm;
      const contribution =
        denom === 0 ? 0 : (idf * posting.termFrequency * (index.k1 + 1)) / denom;
      scores.set(posting.unitId, (scores.get(posting.unitId) ?? 0) + contribution);
    }
  }

  return scores;
}

/**
 * Create a {@link SearchEngine} that serves queries from a {@link LexicalIndex}
 * with BM25 scoring instead of cosine similarity. Produces the exact same
 * `SearchResult` shape as the cosine (`search-engine.ts`) and FAISS
 * (`faiss-engine.ts`) engines, so callers can swap engines without touching
 * downstream code.
 */
export function createLexicalSearchEngine(
  units: SearchUnit[],
  index: LexicalIndex,
): SearchEngine {
  const unitMap = new Map(units.map((u) => [u.unitId, u]));

  return {
    async search(
      query: string,
      options?: SearchOptions,
    ): Promise<SearchResult[]> {
      const limit = options?.limit ?? 5;
      const minScore = options?.minScore ?? 0;
      const clusterFilter = options?.cluster;
      const entityTypeFilter = options?.entityType;

      const scores = scoreLexicalQuery(index, query);

      const scored: Array<{ unitId: string; score: number }> = [];
      for (const [unitId, score] of scores) {
        const unit = unitMap.get(unitId);
        if (!unit) continue;
        if (clusterFilter && unit.cluster !== clusterFilter) continue;
        if (entityTypeFilter && unit.entityType !== entityTypeFilter) continue;
        if (score >= minScore) scored.push({ unitId, score });
      }

      // Sort by score descending; break ties by unitId for determinism.
      scored.sort((a, c) => c.score - a.score || a.unitId.localeCompare(c.unitId));
      const topK = scored.slice(0, limit);

      return topK.map(({ unitId, score }) => {
        const unit = unitMap.get(unitId)!;
        return {
          nodeId: unit.nodeId,
          title: unit.title,
          cluster: unit.cluster,
          score,
          snippet: makeSnippet(unit.text),
          chunkIndex: unit.chunkIndex,
          path: unit.path,
          parentId: unit.parentId,
          identity: unit.identity,
          entityType: unit.entityType,
          connections: unit.connections,
          metadata: unit.metadata,
        };
      });
    },
  };
}

/** Model label recorded for a {@link LexicalProvider} instance. */
const DEFAULT_LEXICAL_MODEL = 'lexical-bm25';

/**
 * Zero-credential lexical provider: satisfies the {@link EmbeddingProvider}
 * contract for registry participation (`name` / `model` / `dimensions`), but
 * `embed()` intentionally throws — see the module docstring for why BM25
 * cannot be expressed as a stateless per-call embedding. Real index build and
 * query goes through {@link buildLexicalIndex} and
 * {@link createLexicalSearchEngine}.
 */
export class LexicalProvider implements EmbeddingProvider {
  readonly name = LEXICAL_PROVIDER_NAME;
  readonly model: string;
  readonly dimensions = 0;

  constructor(config: { model?: string; dimensions?: number } = {}) {
    this.model = config.model || DEFAULT_LEXICAL_MODEL;
  }

  embed(_texts: string[]): Promise<number[][]> {
    return Promise.reject(
      new Error(
        'LexicalProvider does not produce dense embedding vectors. BM25 needs ' +
          'whole-corpus term statistics (document frequency, average document ' +
          'length) that a stateless embed() call cannot carry between index build ' +
          'and query time. Build a term index with buildLexicalIndex(units) and ' +
          'serve queries with createLexicalSearchEngine(units, index) instead.',
      ),
    );
  }
}
