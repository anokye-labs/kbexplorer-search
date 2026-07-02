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
import {
  resolveAccessConfig,
  isExcludedByAccess,
  type AccessExclusionConfig,
} from './access.js';

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
 *
 * Access labels are respected on the index-build path (issue #9): nodes whose
 * `access` label is excluded under `accessConfig` are dropped entirely in the
 * default `exclude` mode, or indexed with their `access` label attached in the
 * opt-in host-predicate filtered (`include`) mode. Exclusion is a pure function
 * of (label, config), so artifacts stay deterministic and the drift gate green.
 */
export function extractSearchUnits(
  graph: KBGraph,
  config?: Partial<ResolvedChunkingConfig>,
  accessConfig?: Partial<AccessExclusionConfig>,
): SearchUnit[] {
  const chunkConfig: ResolvedChunkingConfig = {
    ...DEFAULT_CHUNKING,
    ...config,
  };
  const access = resolveAccessConfig(accessConfig);

  // Nodes dropped entirely from the index (default `exclude` mode only — in
  // `include` mode every node still gets a unit, so nothing needs filtering
  // out of the adjacency views built below).
  //
  // AF-001 / #15 / #16: an excluded node must be unreachable from ANY public
  // unit — not just absent as its own unit. That means `buildConnectionMap`,
  // `getNeighborTitles`, and `buildHierarchyPath` (and the raw `parentId`
  // pass-through) must be derived from a FILTERED node map + FILTERED edge
  // list that never mentions an excluded node, computed up front, before any
  // adjacency/context data is built.
  const excludedNodeIds = new Set(
    graph.nodes
      .filter((n) => isExcludedByAccess(n.access, access) && access.mode === 'exclude')
      .map((n) => n.id),
  );

  const nodeMap = new Map(
    graph.nodes.filter((n) => !excludedNodeIds.has(n.id)).map((n) => [n.id, n]),
  );
  const edges = graph.edges.filter(
    (e) => !excludedNodeIds.has(e.from) && !excludedNodeIds.has(e.to),
  );
  const connectionMap = buildConnectionMap(edges);
  const units: SearchUnit[] = [];

  // Process nodes in sorted order for determinism
  const sortedNodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id));

  for (const node of sortedNodes) {
    // Respect access labels (issue #9). In the default `exclude` mode an
    // access-restricted node yields no unit/vector at all. In the opt-in
    // `include` mode it is indexed with its label attached for host filtering.
    const excluded = isExcludedByAccess(node.access, access);
    if (excluded && access.mode === 'exclude') continue;
    // Carry the access label for ALL labeled nodes (AF-017/AF-018-M1), not
    // just ones that happen to match the exclusion criteria — a host running
    // in `include` mode needs every label (including e.g. `public`) to
    // enforce a query-time filter. A node with no label at all still yields
    // `undefined` here, which is the documented fails-open default: a
    // missing label is treated as public (AF-018-M2).
    const unitAccess = node.access;

    // Use rawContent (markdown) as primary; fall back to stripped HTML
    const bodyText = node.rawContent?.trim()
      ? node.rawContent.trim()
      : stripHtml(node.content).trim();

    // Skip nodes with no searchable content
    if (!bodyText) continue;

    const connections = connectionMap.get(node.id) ?? [];
    const hierarchyPath = buildHierarchyPath(node.id, nodeMap);
    const neighborTitles = getNeighborTitles(node.id, edges, nodeMap);
    // An excluded node never gets a unit of its own, so exposing it as a raw
    // `parentId` would still leak its id via a public child's unit (#16).
    const parentId =
      node.parent && !excludedNodeIds.has(node.parent) ? node.parent : undefined;
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
        parentId,
        entityType: node.entityType,
        identity: node.identity,
        connections,
        access: unitAccess,
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
          parentId,
          entityType: node.entityType,
          identity: node.identity,
          connections,
          access: unitAccess,
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
