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
  LexicalIndex,
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
 *
 * `providerType` tags `index-meta.json` with which kind of provider produced
 * the set (omitted means the historical default, a dense-vector embedding
 * provider). Lexical (BM25) index builds pass `vectors: []` here — there are
 * no embedding vectors — and separately write `lexical-index.json` via
 * {@link writeLexicalIndex} (or use {@link writeLexicalArtifacts}, which does
 * both in one call).
 */
export function writeArtifacts(
  dir: string,
  units: SearchUnit[],
  vectors: EmbeddingVector[],
  config: SearchConfig,
  contentHash: string,
  providerType?: 'embedding' | 'lexical',
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
    providerType,
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

/** Default BM25 model label recorded in `index-meta.json` for lexical builds. */
const DEFAULT_LEXICAL_MODEL = 'lexical-bm25';

/**
 * Write the lexical BM25 index artifact (`lexical-index.json`) to `dir`.
 * Canonical JSON: sorted keys, trailing newline, byte-identical for identical
 * input (same rules as {@link writeArtifacts}).
 */
export function writeLexicalIndex(dir: string, index: LexicalIndex): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(dir, 'lexical-index.json'), canonicalStringify(index));
}

/**
 * Read the lexical BM25 index artifact from `dir`. Returns null if absent.
 */
export function readLexicalIndex(dir: string): LexicalIndex | null {
  const indexPath = join(dir, 'lexical-index.json');
  if (!existsSync(indexPath)) return null;
  return JSON.parse(readFileSync(indexPath, 'utf8'));
}

/**
 * Write the full lexical artifact set in one call: `units.json` +
 * `vectors.json` (empty — a BM25 index has no embedding vectors) +
 * `index-meta.json` (tagged `providerType: 'lexical'`) via
 * {@link writeArtifacts}, plus `lexical-index.json` via
 * {@link writeLexicalIndex}. This is the SAME checked-in artifact shape as
 * an embedding-provider build, so {@link readArtifacts} and the CI drift gate
 * ({@link checkDrift} in `drift.ts`) work unchanged against a lexical index
 * directory — only `lexical-index.json` is additive.
 */
export function writeLexicalArtifacts(
  dir: string,
  units: SearchUnit[],
  index: LexicalIndex,
  contentHash: string,
  model: string = DEFAULT_LEXICAL_MODEL,
): void {
  writeArtifacts(
    dir,
    units,
    [],
    { embedding: { provider: 'lexical', model, dimensions: 0 }, artifacts: { dir } },
    contentHash,
    'lexical',
  );
  writeLexicalIndex(dir, index);
}

/**
 * Read the full lexical artifact set written by {@link writeLexicalArtifacts}.
 * Returns null if either the standard artifact set or `lexical-index.json`
 * is missing.
 */
export function readLexicalArtifacts(
  dir: string,
): { meta: IndexMeta; units: SearchUnit[]; index: LexicalIndex } | null {
  const artifact = readArtifacts(dir);
  const index = readLexicalIndex(dir);
  if (!artifact || !index) return null;
  return { meta: artifact.meta, units: artifact.units, index };
}
