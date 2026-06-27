/**
 * KBGraph -> SearchUnit[] extraction pipeline.
 *
 * Converts a kbexplorer knowledge graph into an array of SearchUnits — the
 * atomic searchable entities. Each unit carries graph-aware metadata so that
 * embeddings capture structure, not just prose.
 *
 * Deterministic: same graph -> same SearchUnits (stable ordering, no randomness).
 */

import type { KBGraph, KBNode, KBEdge } from './kbexplorer-types.js';
import type { SearchUnit, ResolvedChunkingConfig } from './types.js';
import { DEFAULT_CHUNKING } from './types.js';

/**
 * Strip HTML tags from content, producing plain text.
 * Used when rawContent is unavailable and only rendered HTML exists.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Rough token count estimate (whitespace-split words). */
function estimateTokens(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Resolve the file path from a NodeSource, if available.
 */
function resolveSourcePath(source: KBNode['source']): string | undefined {
  if ('file' in source && typeof source.file === 'string') return source.file;
  if ('path' in source && typeof source.path === 'string') return source.path;
  return undefined;
}

/**
 * Build a map of nodeId -> list of connected node IDs from edges.
 */
function buildConnectionMap(edges: KBEdge[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const edge of edges) {
    if (!map.has(edge.from)) map.set(edge.from, []);
    if (!map.has(edge.to)) map.set(edge.to, []);
    map.get(edge.from)!.push(edge.to);
    map.get(edge.to)!.push(edge.from);
  }
  // Deduplicate and sort for determinism
  for (const [key, ids] of map) {
    map.set(key, [...new Set(ids)].sort());
  }
  return map;
}

/**
 * Build the hierarchy path (ancestor titles) for a node.
 * Returns an array from immediate parent to root.
 */
function buildHierarchyPath(
  nodeId: string,
  nodeMap: Map<string, KBNode>,
  maxDepth = 8,
): string[] {
  const path: string[] = [];
  let current = nodeMap.get(nodeId);
  let depth = 0;
  while (current?.parent && depth < maxDepth) {
    const parent = nodeMap.get(current.parent);
    if (!parent) break;
    path.push(parent.title);
    current = parent;
    depth++;
  }
  return path;
}

/**
 * Get the titles of a node's 1-hop neighbors, sorted by edge weight.
 * Returns at most `max` titles.
 */
function getNeighborTitles(
  nodeId: string,
  edges: KBEdge[],
  nodeMap: Map<string, KBNode>,
  max = 8,
): string[] {
  const neighbors: Array<{ id: string; weight: number }> = [];

  for (const edge of edges) {
    if (edge.from === nodeId && edge.to !== nodeId) {
      neighbors.push({ id: edge.to, weight: edge.weight });
    } else if (edge.to === nodeId && edge.from !== nodeId) {
      neighbors.push({ id: edge.from, weight: edge.weight });
    }
  }

  // Deduplicate by ID, keeping highest weight
  const best = new Map<string, number>();
  for (const n of neighbors) {
    const existing = best.get(n.id) ?? 0;
    if (n.weight > existing) best.set(n.id, n.weight);
  }

  return [...best.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([id]) => nodeMap.get(id)?.title ?? id)
    .sort(); // sort alphabetically for determinism
}

/**
 * Resolve the cluster display name for a node.
 */
function resolveClusterName(
  clusterId: string,
  clusters: KBGraph['clusters'],
): string {
  const cluster = clusters.find((c) => c.id === clusterId);
  return cluster?.name ?? clusterId;
}

/**
 * Build the context header prepended to SearchUnit text.
 * Captures graph structure in the embedding.
 */
function buildContextHeader(
  title: string,
  clusterName: string,
  hierarchyPath: string[],
  neighborTitles: string[],
): string {
  const parts = [`Title: ${title}`, `Cluster: ${clusterName}`];
  if (hierarchyPath.length > 0) {
    parts.push(`Path: ${hierarchyPath.join(' > ')}`);
  }
  if (neighborTitles.length > 0) {
    parts.push(`Related: ${neighborTitles.join(', ')}`);
  }
  return parts.join(' | ');
}

/**
 * Split text into chunks at heading boundaries (## or ###).
 * Each chunk includes some overlap from the previous chunk's tail.
 */
function chunkAtHeadings(
  text: string,
  config: ResolvedChunkingConfig,
): string[] {
  const lines = text.split('\n');
  const chunks: string[] = [];
  let currentChunk: string[] = [];
  let currentTokens = 0;

  for (const line of lines) {
    const isHeading = /^#{2,3}\s/.test(line);
    const lineTokens = estimateTokens(line);

    if (isHeading && currentTokens > 0 && currentTokens + lineTokens > config.maxTokens) {
      // Flush current chunk
      chunks.push(currentChunk.join('\n').trim());

      // Start new chunk with overlap from the end of the previous chunk
      const overlapLines: string[] = [];
      let overlapTokens = 0;
      for (let i = currentChunk.length - 1; i >= 0 && overlapTokens < config.overlap; i--) {
        overlapLines.unshift(currentChunk[i]);
        overlapTokens += estimateTokens(currentChunk[i]);
      }
      currentChunk = [...overlapLines, line];
      currentTokens = overlapTokens + lineTokens;
    } else if (currentTokens + lineTokens > config.maxTokens && currentChunk.length > 0) {
      // Non-heading overflow: flush and restart
      chunks.push(currentChunk.join('\n').trim());
      const overlapLines: string[] = [];
      let overlapTokens = 0;
      for (let i = currentChunk.length - 1; i >= 0 && overlapTokens < config.overlap; i--) {
        overlapLines.unshift(currentChunk[i]);
        overlapTokens += estimateTokens(currentChunk[i]);
      }
      currentChunk = [...overlapLines, line];
      currentTokens = overlapTokens + lineTokens;
    } else {
      currentChunk.push(line);
      currentTokens += lineTokens;
    }
  }

  if (currentChunk.length > 0) {
    const trimmed = currentChunk.join('\n').trim();
    if (trimmed) chunks.push(trimmed);
  }

  return chunks.length > 0 ? chunks : [text.trim()];
}

/**
 * Extract SearchUnits from a KBGraph.
 *
 * Each node with non-empty rawContent produces one or more SearchUnits.
 * Long nodes are chunked at heading boundaries. Each unit's text is
 * prepended with a context header capturing graph structure.
 *
 * Output is deterministic: sorted by unitId.
 */
export function extractSearchUnits(
  graph: KBGraph,
  config?: Partial<ResolvedChunkingConfig>,
): SearchUnit[] {
  const chunkConfig: ResolvedChunkingConfig = {
    ...DEFAULT_CHUNKING,
    ...config,
  };

  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const connectionMap = buildConnectionMap(graph.edges);
  const units: SearchUnit[] = [];

  // Process nodes in sorted order for determinism
  const sortedNodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id));

  for (const node of sortedNodes) {
    // Use rawContent (markdown) as primary; fall back to stripped HTML
    const bodyText = node.rawContent?.trim()
      ? node.rawContent.trim()
      : stripHtml(node.content).trim();

    // Skip nodes with no searchable content
    if (!bodyText) continue;

    const connections = connectionMap.get(node.id) ?? [];
    const hierarchyPath = buildHierarchyPath(node.id, nodeMap);
    const neighborTitles = getNeighborTitles(node.id, graph.edges, nodeMap);
    const clusterName = resolveClusterName(node.cluster, graph.clusters);
    const contextHeader = buildContextHeader(
      node.title,
      clusterName,
      hierarchyPath,
      neighborTitles,
    );
    const sourcePath = resolveSourcePath(node.source);

    const fullText = `${contextHeader}\n\n${bodyText}`;
    const tokens = estimateTokens(fullText);

    if (tokens <= chunkConfig.maxTokens) {
      // Single-chunk unit
      units.push({
        unitId: node.id,
        nodeId: node.id,
        chunkIndex: 0,
        text: fullText,
        title: node.title,
        cluster: node.cluster,
        path: sourcePath,
        parentId: node.parent,
        entityType: node.entityType,
        identity: node.identity,
        connections,
        metadata: {
          hierarchyPath,
          neighborTitles,
          clusterName,
        },
      });
    } else {
      // Multi-chunk: split the body, prepend context header to each chunk
      const bodyChunks = chunkAtHeadings(bodyText, chunkConfig);
      for (let i = 0; i < bodyChunks.length; i++) {
        const chunkText = `${contextHeader}\n\n${bodyChunks[i]}`;
        units.push({
          unitId: `${node.id}#${i}`,
          nodeId: node.id,
          chunkIndex: i,
          text: chunkText,
          title: node.title,
          cluster: node.cluster,
          path: sourcePath,
          parentId: node.parent,
          entityType: node.entityType,
          identity: node.identity,
          connections,
          metadata: {
            hierarchyPath,
            neighborTitles,
            clusterName,
          },
        });
      }
    }
  }

  // Sort by unitId for determinism
  units.sort((a, b) => a.unitId.localeCompare(b.unitId));
  return units;
}
