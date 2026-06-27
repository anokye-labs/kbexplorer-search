/**
 * Graph-aware ranking and related-node suggestions.
 *
 * Enhances raw cosine similarity results with graph structure awareness:
 *
 * 1. **Graph boost**: nodes that are 1-hop neighbors of top-scoring results
 *    receive a configurable score boost, surfacing structurally relevant
 *    nodes that might not match textually.
 *
 * 2. **Cluster affinity**: when multiple results share a cluster, later
 *    results from that cluster receive a mild boost (the query likely
 *    targets that topic area).
 *
 * 3. **Hierarchy boost**: parent nodes of top results get a small boost
 *    (they provide context for the matched content).
 *
 * 4. **Related suggestions**: after ranking, produce a separate list of
 *    graph-neighbor nodes not in the result set — "you might also want"
 *    suggestions derived from the graph, not from embedding similarity.
 */

import type { SearchResult } from './types.js';
import type { SearchUnit } from './types.js';

/** Configuration for graph-aware ranking adjustments. */
export interface GraphRankingConfig {
  /** Score boost for 1-hop neighbors of top results (default: 0.05). */
  neighborBoost?: number;
  /** Score boost for nodes sharing a cluster with the top result (default: 0.02). */
  clusterAffinityBoost?: number;
  /** Score boost for parent nodes of top results (default: 0.03). */
  hierarchyBoost?: number;
  /** Max number of related suggestions to return (default: 3). */
  maxSuggestions?: number;
}

const DEFAULT_CONFIG: Required<GraphRankingConfig> = {
  neighborBoost: 0.05,
  clusterAffinityBoost: 0.02,
  hierarchyBoost: 0.03,
  maxSuggestions: 3,
};

/** A related-node suggestion derived from graph structure. */
export interface RelatedSuggestion {
  /** Node ID of the suggested node. */
  nodeId: string;
  /** Title of the suggested node. */
  title: string;
  /** Cluster of the suggested node. */
  cluster: string;
  /** Why this node was suggested. */
  reason: 'neighbor' | 'parent' | 'child' | 'shared-cluster';
  /** Which result node(s) triggered the suggestion. */
  sourceNodeIds: string[];
}

/** Result of graph-aware ranking. */
export interface GraphRankedResult {
  /** Re-ranked search results with boosted scores. */
  results: SearchResult[];
  /** Related nodes not in the result set, derived from graph structure. */
  suggestions: RelatedSuggestion[];
}

/**
 * Apply graph-aware ranking boosts to raw search results.
 *
 * Takes the raw cosine-scored results and the full set of SearchUnits
 * (for graph context), then:
 * 1. Boosts neighbors of top results
 * 2. Boosts cluster-affinity matches
 * 3. Boosts parent nodes
 * 4. Re-sorts by adjusted score
 * 5. Produces related suggestions from graph neighbors not in results
 */
export function applyGraphRanking(
  results: SearchResult[],
  allUnits: SearchUnit[],
  config?: GraphRankingConfig,
): GraphRankedResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (results.length === 0) {
    return { results: [], suggestions: [] };
  }

  // Index by nodeId for multi-chunk nodes
  const nodeToUnits = new Map<string, SearchUnit[]>();
  for (const u of allUnits) {
    const list = nodeToUnits.get(u.nodeId) ?? [];
    list.push(u);
    nodeToUnits.set(u.nodeId, list);
  }

  // Build connection map: nodeId -> Set<connectedNodeId>
  const connectionMap = new Map<string, Set<string>>();
  for (const unit of allUnits) {
    if (!connectionMap.has(unit.nodeId)) {
      connectionMap.set(unit.nodeId, new Set());
    }
    for (const conn of unit.connections) {
      connectionMap.get(unit.nodeId)!.add(conn);
    }
  }

  // Build parent map: nodeId -> parentId
  const parentMap = new Map<string, string>();
  // Build children map: parentId -> Set<childId>
  const childrenMap = new Map<string, Set<string>>();
  for (const unit of allUnits) {
    if (unit.parentId) {
      parentMap.set(unit.nodeId, unit.parentId);
      const children = childrenMap.get(unit.parentId) ?? new Set();
      children.add(unit.nodeId);
      childrenMap.set(unit.parentId, children);
    }
  }

  // Identify top result's cluster for affinity
  const topCluster = results[0].cluster;

  // Collect node IDs of top results (use top 3 for neighbor boosting)
  const topNodeIds = new Set(results.slice(0, 3).map((r) => r.nodeId));
  const resultNodeIds = new Set(results.map((r) => r.nodeId));

  // Compute neighbor set of top results
  const topNeighbors = new Set<string>();
  for (const nodeId of topNodeIds) {
    const conns = connectionMap.get(nodeId);
    if (conns) {
      for (const c of conns) topNeighbors.add(c);
    }
  }

  // Compute parent set of top results
  const topParents = new Set<string>();
  for (const nodeId of topNodeIds) {
    const parent = parentMap.get(nodeId);
    if (parent) topParents.add(parent);
  }

  // Apply boosts
  const boosted = results.map((r) => {
    let adjustedScore = r.score;

    // Neighbor boost: this result is a neighbor of a top result (but not itself a source)
    if (topNeighbors.has(r.nodeId) && !topNodeIds.has(r.nodeId)) {
      adjustedScore += cfg.neighborBoost;
    } else if (topNeighbors.has(r.nodeId) && topNodeIds.has(r.nodeId)) {
      // Mutual neighbors among top results still get a partial boost
      adjustedScore += cfg.neighborBoost * 0.5;
    }

    // Cluster affinity boost: shares cluster with top result
    if (r.cluster === topCluster && r.nodeId !== results[0].nodeId) {
      adjustedScore += cfg.clusterAffinityBoost;
    }

    // Hierarchy boost: this result is a parent of a top result
    if (topParents.has(r.nodeId)) {
      adjustedScore += cfg.hierarchyBoost;
    }

    // Clamp to [0, 1]
    adjustedScore = Math.min(1, Math.max(0, adjustedScore));

    return { ...r, score: adjustedScore };
  });

  // Re-sort by adjusted score
  boosted.sort((a, b) => b.score - a.score);

  // Generate related suggestions from graph neighbors not in results.
  // Duplicates are allowed here — the merge step below combines them and
  // accumulates sourceNodeIds so multi-source suggestions rank higher.
  const suggestions: RelatedSuggestion[] = [];

  for (const nodeId of topNodeIds) {
    // Neighbors
    const conns = connectionMap.get(nodeId);
    if (conns) {
      for (const connId of conns) {
        if (resultNodeIds.has(connId)) continue;
        const units = nodeToUnits.get(connId);
        if (!units || units.length === 0) continue;
        const unit = units[0];
        suggestions.push({
          nodeId: connId,
          title: unit.title,
          cluster: unit.cluster,
          reason: 'neighbor',
          sourceNodeIds: [nodeId],
        });
      }
    }

    // Parent
    const parent = parentMap.get(nodeId);
    if (parent && !resultNodeIds.has(parent)) {
      const units = nodeToUnits.get(parent);
      if (units && units.length > 0) {
        suggestions.push({
          nodeId: parent,
          title: units[0].title,
          cluster: units[0].cluster,
          reason: 'parent',
          sourceNodeIds: [nodeId],
        });
      }
    }

    // Children
    const children = childrenMap.get(nodeId);
    if (children) {
      for (const childId of children) {
        if (resultNodeIds.has(childId)) continue;
        const units = nodeToUnits.get(childId);
        if (!units || units.length === 0) continue;
        suggestions.push({
          nodeId: childId,
          title: units[0].title,
          cluster: units[0].cluster,
          reason: 'child',
          sourceNodeIds: [nodeId],
        });
      }
    }
  }

  // Merge duplicate suggestions (same node suggested by multiple sources)
  const merged = new Map<string, RelatedSuggestion>();
  for (const s of suggestions) {
    const existing = merged.get(s.nodeId);
    if (existing) {
      for (const src of s.sourceNodeIds) {
        if (!existing.sourceNodeIds.includes(src)) {
          existing.sourceNodeIds.push(src);
        }
      }
    } else {
      merged.set(s.nodeId, { ...s });
    }
  }

  // Sort suggestions: prefer nodes referenced by more sources, then alphabetically
  const sortedSuggestions = [...merged.values()]
    .sort((a, b) => {
      const countDiff = b.sourceNodeIds.length - a.sourceNodeIds.length;
      if (countDiff !== 0) return countDiff;
      return a.nodeId.localeCompare(b.nodeId);
    })
    .slice(0, cfg.maxSuggestions);

  return { results: boosted, suggestions: sortedSuggestions };
}
