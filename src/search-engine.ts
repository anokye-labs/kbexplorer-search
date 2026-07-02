/**
 * Pure-JS cosine similarity search engine.
 *
 * Loads search artifacts and serves semantic queries using brute-force
 * cosine similarity. Portable — works everywhere without native binaries.
 * For large indexes, the optional FAISS engine provides faster k-NN.
 */

import type { EmbeddingProvider } from './providers/interface.js';
import type {
  EmbeddingArtifact,
  SearchResult,
  SearchOptions,
  SearchEngine,
} from './types.js';
import { makeSnippet } from './snippet.js';

/** Cosine similarity between two vectors. */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Create a pure-JS cosine similarity search engine from artifacts.
 */
export function createSearchEngine(
  artifact: EmbeddingArtifact,
  provider: EmbeddingProvider,
): SearchEngine {
  const { units, vectors } = artifact;

  // Build unit lookup by unitId
  const unitMap = new Map(units.map((u) => [u.unitId, u]));
  const vectorMap = new Map(vectors.map((v) => [v.unitId, v]));

  return {
    async search(
      query: string,
      options?: SearchOptions,
    ): Promise<SearchResult[]> {
      const limit = options?.limit ?? 5;
      const minScore = options?.minScore ?? 0;
      const clusterFilter = options?.cluster;
      const entityTypeFilter = options?.entityType;

      // Embed the query
      const [queryVector] = await provider.embed([query]);

      // Score every vector
      const scored: Array<{ unitId: string; score: number }> = [];
      for (const [unitId, vec] of vectorMap) {
        const unit = unitMap.get(unitId);
        if (!unit) continue;

        // Apply filters
        if (clusterFilter && unit.cluster !== clusterFilter) continue;
        if (entityTypeFilter && unit.entityType !== entityTypeFilter) continue;

        const score = cosineSimilarity(queryVector, vec.vector);
        if (score >= minScore) {
          scored.push({ unitId, score });
        }
      }

      // Sort by score descending, take top-k
      scored.sort((a, b) => b.score - a.score);
      const topK = scored.slice(0, limit);

      // Map to SearchResult
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
