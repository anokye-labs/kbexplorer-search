/**
 * Optional FAISS-accelerated search engine.
 *
 * Provides faster k-NN for large indexes by building a FAISS IndexFlatIP
 * (inner-product / cosine on L2-normalized vectors) from the portable
 * JSON artifacts. Falls back to pure-JS cosine search if `faiss-node`
 * is not installed.
 *
 * FAISS is a **runtime accelerator only** — the JSON artifact set remains
 * the durable source of truth. The FAISS index is rebuilt from artifacts
 * at construction time and is never persisted.
 */

import type { EmbeddingProvider } from './providers/interface.js';
import type {
  EmbeddingArtifact,
  SearchResult,
  SearchOptions,
  SearchEngine,
  SearchUnit,
} from './types.js';
import { createSearchEngine } from './search-engine.js';
import { makeSnippet } from './snippet.js';

/** The subset of the `faiss-node` module surface this engine depends on. */
export interface FaissModule {
  IndexFlatIP: new (dimensions: number) => {
    add: (vector: number[]) => void;
    search: (query: number[], k: number) => { distances: number[]; labels: number[] };
    ntotal: () => number;
  };
}

/** Configuration for the FAISS engine. */
export interface FaissEngineConfig {
  /**
   * If true, silently fall back to pure-JS cosine when faiss-node
   * is unavailable (default: true).
   */
  fallback?: boolean;
  /**
   * Internal test seam — overrides how the `faiss-node` module is loaded.
   * Defaults to the real dynamic `import('faiss-node')`. Not part of the
   * supported public API surface; it exists so tests can deterministically
   * simulate faiss-node being present or absent regardless of whether it
   * actually built on the machine running the tests.
   */
  loadFaiss?: () => Promise<FaissModule>;
}

/** Default loader: the real dynamic import of the optional native module. */
async function defaultLoadFaiss(): Promise<FaissModule> {
  return import('faiss-node');
}

/** Result of attempting to create a FAISS engine. */
export interface FaissEngineResult {
  /** The search engine (FAISS-backed or pure-JS fallback). */
  engine: SearchEngine;
  /** Whether FAISS is actually being used. */
  accelerated: boolean;
}

/** L2-normalize a vector in place and return it. */
function l2Normalize(vec: number[]): number[] {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

/**
 * Build result objects from FAISS search output.
 */
function buildResults(
  indices: number[],
  distances: number[],
  unitOrder: SearchUnit[],
  unitMap: Map<string, SearchUnit>,
  options: SearchOptions | undefined,
): SearchResult[] {
  const minScore = options?.minScore ?? 0;
  const clusterFilter = options?.cluster;
  const entityTypeFilter = options?.entityType;
  const filterUnit = options?.filterUnit;
  const results: SearchResult[] = [];

  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    if (idx < 0) continue; // FAISS returns -1 for unfilled slots

    const score = distances[i]; // inner product = cosine on normalized vecs
    if (score < minScore) continue;

    const unit = unitOrder[idx];
    if (!unit) continue;
    if (clusterFilter && unit.cluster !== clusterFilter) continue;
    if (entityTypeFilter && unit.entityType !== entityTypeFilter) continue;
    if (filterUnit && !filterUnit(unit)) continue;

    results.push({
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
    });
  }

  return results;
}

/**
 * Attempt to create a FAISS-accelerated search engine.
 *
 * If `faiss-node` is installed, builds an IndexFlatIP from the artifact
 * vectors and returns an accelerated engine. Otherwise falls back to
 * the pure-JS cosine engine (unless `config.fallback` is false, in
 * which case it throws).
 */
export async function createFaissEngine(
  artifact: EmbeddingArtifact,
  provider: EmbeddingProvider,
  config?: FaissEngineConfig,
): Promise<FaissEngineResult> {
  const shouldFallback = config?.fallback !== false;
  const loadFaiss = config?.loadFaiss ?? defaultLoadFaiss;

  // Try to load faiss-node
  let faiss: FaissModule;

  try {
    faiss = await loadFaiss();
  } catch {
    if (shouldFallback) {
      console.warn(
        'kbexplorer-search: FAISS-accelerated search unavailable (faiss-node is ' +
          'not installed or has no prebuilt binary for this platform) — using the ' +
          'pure-JS cosine engine instead. See the README for optional install ' +
          'instructions if you want accelerated k-NN on large indexes.',
      );
      return {
        engine: createSearchEngine(artifact, provider),
        accelerated: false,
      };
    }
    throw new Error(
      'faiss-node is not installed. Install it with: npm install faiss-node\n' +
      'Or set fallback: true to use pure-JS cosine search.',
    );
  }

  const { units, vectors } = artifact;
  const dimensions = artifact.meta.dimensions;
  const unitMap = new Map(units.map((u) => [u.unitId, u]));
  const vectorMap = new Map(vectors.map((v) => [v.unitId, v]));

  // Build FAISS index — maintain ordered list for index-to-unit mapping
  const index = new faiss.IndexFlatIP(dimensions);
  const unitOrder: SearchUnit[] = [];

  for (const unit of units) {
    const vec = vectorMap.get(unit.unitId);
    if (!vec) continue;

    // L2-normalize for cosine similarity via inner product
    const normalized = l2Normalize([...vec.vector]);
    index.add(normalized);
    unitOrder.push(unit);
  }

  const engine: SearchEngine = {
    async search(
      query: string,
      options?: SearchOptions,
    ): Promise<SearchResult[]> {
      const limit = options?.limit ?? 5;

      // Embed and normalize the query
      const [rawQueryVector] = await provider.embed([query]);
      const queryVector = l2Normalize([...rawQueryVector]);

      // FAISS k-NN search — request more than limit to allow for filtering
      const overFetch = Math.min(index.ntotal(), limit * 3);
      const { distances, labels } = index.search(queryVector, overFetch);

      const results = buildResults(labels, distances, unitOrder, unitMap, options);

      // Take top-k after filtering
      return results.slice(0, limit);
    },
  };

  return { engine, accelerated: true };
}
