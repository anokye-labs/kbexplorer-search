/**
 * CI drift detection gate.
 *
 * Compares committed search artifacts against a fresh extraction from the
 * current graph. Never calls the embedding provider — purely deterministic.
 * Exits non-zero when units diverge or content hash mismatches.
 */

import type { KBGraph } from './kbexplorer-types.js';
import type { ResolvedChunkingConfig } from './types.js';
import { extractSearchUnits } from './extract.js';
import { readArtifacts, computeContentHash, canonicalStringify } from './artifacts.js';

export interface DriftResult {
  /** True if committed artifacts match the current graph. */
  fresh: boolean;
  /** Unit IDs present in the current graph but missing from artifacts. */
  missingUnits: string[];
  /** Unit IDs present in artifacts but not in the current graph. */
  extraUnits: string[];
  /** Unit IDs whose text content differs between artifacts and current graph. */
  staleUnits: string[];
  /** Whether the content hash in index-meta.json matches the current graph. */
  contentHashMatch: boolean;
}

/**
 * Check whether committed artifacts are fresh relative to the current graph.
 *
 * Re-extracts SearchUnits from the graph (no embedding call) and compares
 * against the committed units.json + index-meta.json.
 */
export function checkDrift(
  artifactDir: string,
  graph: KBGraph,
  chunkingConfig?: Partial<ResolvedChunkingConfig>,
): DriftResult {
  const artifact = readArtifacts(artifactDir);
  if (!artifact) {
    return {
      fresh: false,
      missingUnits: [],
      extraUnits: [],
      staleUnits: [],
      contentHashMatch: false,
    };
  }

  // Check content hash
  const currentHash = computeContentHash(graph);
  const contentHashMatch = artifact.meta.contentHash === currentHash;

  // Re-extract units from the current graph
  const currentUnits = extractSearchUnits(graph, chunkingConfig);
  const committedUnits = artifact.units;

  // Build maps for comparison
  const currentMap = new Map(currentUnits.map((u) => [u.unitId, u]));
  const committedMap = new Map(committedUnits.map((u) => [u.unitId, u]));

  const missingUnits: string[] = [];
  const extraUnits: string[] = [];
  const staleUnits: string[] = [];

  // Find missing (in current but not committed)
  for (const [id, unit] of currentMap) {
    const committed = committedMap.get(id);
    if (!committed) {
      missingUnits.push(id);
    } else if (canonicalStringify(unit) !== canonicalStringify(committed)) {
      staleUnits.push(id);
    }
  }

  // Find extra (in committed but not current)
  for (const id of committedMap.keys()) {
    if (!currentMap.has(id)) {
      extraUnits.push(id);
    }
  }

  missingUnits.sort();
  extraUnits.sort();
  staleUnits.sort();

  const fresh =
    contentHashMatch &&
    missingUnits.length === 0 &&
    extraUnits.length === 0 &&
    staleUnits.length === 0;

  return { fresh, missingUnits, extraUnits, staleUnits, contentHashMatch };
}
