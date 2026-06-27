/**
 * Batch embedding generation with content-hash caching.
 *
 * Converts SearchUnits into EmbeddingVectors using a pluggable provider.
 * Content-hash keyed: re-running on unchanged text skips the API call.
 */

import { createHash } from 'node:crypto';
import type { EmbeddingProvider } from './providers/interface.js';
import type { SearchUnit, EmbeddingVector, EmbeddingArtifact } from './types.js';
import { DEFAULT_BATCH_SIZE } from './types.js';

/** SHA-256 hash of a string. */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Progress callback shape. */
export type EmbedProgressCallback = (progress: {
  completed: number;
  total: number;
  cached: number;
  embedded: number;
}) => void;

export interface GenerateEmbeddingsOptions {
  batchSize?: number;
  delayMs?: number;
  previousArtifact?: EmbeddingArtifact;
  onProgress?: EmbedProgressCallback;
}

/**
 * Generate embeddings for a set of SearchUnits.
 *
 * If a previousArtifact is provided, units whose text hash + model + dimensions
 * match a cached vector are skipped (no API call).
 */
export async function generateEmbeddings(
  units: SearchUnit[],
  provider: EmbeddingProvider,
  options?: GenerateEmbeddingsOptions,
): Promise<EmbeddingVector[]> {
  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
  const delayMs = options?.delayMs ?? 100;
  const onProgress = options?.onProgress;

  // Build cache from previous artifact
  const cache = new Map<string, number[]>();
  if (options?.previousArtifact) {
    const prev = options.previousArtifact;
    for (let i = 0; i < prev.units.length; i++) {
      const prevUnit = prev.units[i];
      const prevVector = prev.vectors[i];
      if (
        prevVector &&
        prevVector.model === provider.model &&
        prevVector.dimensions === provider.dimensions
      ) {
        const key = hashText(prevUnit.text);
        cache.set(`${prevUnit.unitId}:${key}`, prevVector.vector);
      }
    }
  }

  const results: EmbeddingVector[] = [];
  const toEmbed: Array<{ index: number; unit: SearchUnit }> = [];
  let cachedCount = 0;

  // Separate cached vs. needs-embedding
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const key = `${unit.unitId}:${hashText(unit.text)}`;
    const cached = cache.get(key);
    if (cached) {
      results.push({
        unitId: unit.unitId,
        vector: cached,
        model: provider.model,
        dimensions: provider.dimensions,
      });
      cachedCount++;
    } else {
      toEmbed.push({ index: i, unit });
    }
  }

  onProgress?.({
    completed: cachedCount,
    total: units.length,
    cached: cachedCount,
    embedded: 0,
  });

  // Batch embed the uncached units
  let embeddedCount = 0;
  for (let batchStart = 0; batchStart < toEmbed.length; batchStart += batchSize) {
    const batch = toEmbed.slice(batchStart, batchStart + batchSize);
    const texts = batch.map((b) => b.unit.text);
    const vectors = await provider.embed(texts);

    for (let j = 0; j < batch.length; j++) {
      results.push({
        unitId: batch[j].unit.unitId,
        vector: vectors[j],
        model: provider.model,
        dimensions: provider.dimensions,
      });
    }

    embeddedCount += batch.length;
    onProgress?.({
      completed: cachedCount + embeddedCount,
      total: units.length,
      cached: cachedCount,
      embedded: embeddedCount,
    });

    // Rate limiting delay between batches
    if (batchStart + batchSize < toEmbed.length && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // Sort by unitId for determinism
  results.sort((a, b) => a.unitId.localeCompare(b.unitId));
  return results;
}
