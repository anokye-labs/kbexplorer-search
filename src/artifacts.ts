/**
 * Deterministic artifact read/write.
 *
 * Artifacts are the checked-in search state: index-meta.json, units.json,
 * vectors.json. All serialization is canonical: sorted keys, stable array
 * order, 2-space indent, trailing newline. Identical input produces
 * byte-identical output.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { KBGraph } from './kbexplorer-types.js';
import type {
  SearchUnit,
  EmbeddingVector,
  IndexMeta,
  EmbeddingArtifact,
  SearchConfig,
} from './types.js';
import { ARTIFACT_VERSION } from './types.js';

/**
 * Canonical JSON stringification: sorted keys, 2-space indent, trailing newline.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(value, sortedReplacer, 2) + '\n';
}

/** JSON.stringify replacer that sorts object keys. */
function sortedReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

/**
 * Compute a deterministic content hash for a KBGraph.
 * SHA-256 of the canonical JSON of node ids, titles, rawContent, clusters, and edges.
 */
export function computeContentHash(graph: KBGraph): string {
  const hashInput = {
    nodes: graph.nodes
      .map((n) => ({
        id: n.id,
        title: n.title,
        cluster: n.cluster,
        rawContent: n.rawContent,
        parent: n.parent,
        entityType: n.entityType,
        identity: n.identity,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: graph.edges
      .map((e) => ({
        from: e.from,
        to: e.to,
        type: e.type,
        weight: e.weight,
      }))
      .sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`)),
    clusters: graph.clusters
      .map((c) => ({ id: c.id, name: c.name }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  const json = canonicalStringify(hashInput);
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

/**
 * Write search artifacts to a directory.
 * Creates the directory if it doesn't exist.
 */
export function writeArtifacts(
  dir: string,
  units: SearchUnit[],
  vectors: EmbeddingVector[],
  config: SearchConfig,
  contentHash: string,
): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const meta: IndexMeta = {
    version: ARTIFACT_VERSION,
    contentHash,
    model: config.embedding.model,
    dimensions: config.embedding.dimensions ?? vectors[0]?.dimensions ?? 0,
    unitCount: units.length,
  };

  // Sort arrays for determinism
  const sortedUnits = [...units].sort((a, b) =>
    a.unitId.localeCompare(b.unitId),
  );
  const sortedVectors = [...vectors].sort((a, b) =>
    a.unitId.localeCompare(b.unitId),
  );

  writeFileSync(join(dir, 'index-meta.json'), canonicalStringify(meta));
  writeFileSync(join(dir, 'units.json'), canonicalStringify(sortedUnits));
  writeFileSync(join(dir, 'vectors.json'), canonicalStringify(sortedVectors));
}

/**
 * Read search artifacts from a directory.
 * Returns null if the directory or any required file is missing.
 */
export function readArtifacts(dir: string): EmbeddingArtifact | null {
  const metaPath = join(dir, 'index-meta.json');
  const unitsPath = join(dir, 'units.json');
  const vectorsPath = join(dir, 'vectors.json');

  if (!existsSync(metaPath) || !existsSync(unitsPath) || !existsSync(vectorsPath)) {
    return null;
  }

  const meta: IndexMeta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const units: SearchUnit[] = JSON.parse(readFileSync(unitsPath, 'utf8'));
  const vectors: EmbeddingVector[] = JSON.parse(readFileSync(vectorsPath, 'utf8'));

  return { meta, units, vectors };
}
