/**
 * Inlined subset of kbexplorer types consumed by the search module.
 *
 * These mirror the canonical definitions in kbexplorer-template/src/types/index.ts.
 * TODO: Replace with `@anokye-labs/kbexplorer-core` dependency when published.
 */

export type EdgeType =
  | 'contains'
  | 'derived_from'
  | 'imports'
  | 'references'
  | 'frontmatter'
  | 'mentions'
  | 'cross_references'
  | 'modifies'
  | 'closes'
  | 'related'
  | (string & {});

export type EdgeSource = 'inline' | 'frontmatter' | 'inferred';

export interface Connection {
  to: string;
  type?: EdgeType;
  description: string;
  source?: EdgeSource;
  weight?: number;
  relation?: string;
}

export type NodeSource =
  | { type: 'authored'; file: string }
  | { type: 'issue'; number: number; state: string; labels: string[] }
  | { type: 'pull_request'; number: number; state: string }
  | { type: 'commit'; sha: string }
  | { type: 'file'; path: string }
  | { type: 'readme' }
  | { type: 'section'; parentSource: NodeSource }
  | { type: 'derived'; generator: string }
  | { type: 'external'; provider: string }
  | { type: 'branch'; name: string; protected: boolean }
  | { type: 'workflow'; path: string }
  | { type: 'repository'; owner: string; repo: string }
  | { type: 'structured'; entityType: string; ref?: string }
  | { type: 'release'; tag: string; prerelease: boolean }
  | { type: 'person'; login: string; linked: boolean };

/**
 * Access classification axis (most → least sensitive within the named tiers).
 * `unknown` is treated as maximally sensitive by the access lattice because an
 * unclassified resource may be anything.
 */
export type KBAccessClassification =
  | 'public'
  | 'internal'
  | 'confidential'
  | 'restricted'
  | 'unknown';

/** Access visibility axis. */
export type KBAccessVisibility = 'public' | 'internal' | 'private';

/**
 * An opaque pointer back to the source-of-record policy that produced a label.
 * Mirrors kbexplorer-core's `ExternalRef`; kept structurally loose here.
 */
export interface ExternalRef {
  provider?: string;
  id?: string;
  url?: string;
  [key: string]: unknown;
}

/**
 * Label-only access descriptor carried on nodes/edges.
 *
 * Mirrors the canonical kbexplorer-core `KBAccessLabel` (core v0.3.0). The shape
 * is kept byte-identical to core (classification/visibility/labels[]/
 * sourcePolicyRef) so the inlined mirror does not drift; replace with the core
 * import when `@anokye-labs/kbexplorer-core` is taken as a dependency.
 * kbx **labels**; the host **enforces**. There is deliberately no `canRead`,
 * principals, OAuth, or redactor here.
 */
export interface KBAccessLabel {
  classification?: KBAccessClassification;
  visibility?: KBAccessVisibility;
  labels?: string[];
  sourcePolicyRef?: ExternalRef;
}

export interface JsonLd {
  '@context'?: string | Record<string, unknown> | Array<string | Record<string, unknown>>;
  '@id': string;
  '@type': string | string[];
  [key: string]: unknown;
}

export interface KBNode {
  id: string;
  title: string;
  cluster: string;
  content: string;
  rawContent: string;
  emoji?: string;
  image?: string;
  sprite?: string;
  parent?: string;
  nodeType?: 'parent' | 'section';
  display?: string;
  connections: Connection[];
  identity?: string;
  derived?: boolean;
  source: NodeSource;
  provider?: string;
  entityType?: string;
  jsonld?: JsonLd;
  data?: Record<string, unknown>;
  /** Canonical access label from kbexplorer-core (core v0.3.0 `KBNode.access`). */
  access?: KBAccessLabel;
}

export interface KBEdge {
  from: string;
  to: string;
  type: EdgeType;
  description: string;
  source: EdgeSource;
  weight: number;
  relation?: string;
  /** Canonical access label from kbexplorer-core (core v0.3.0 `KBEdge.access`). */
  access?: KBAccessLabel;
}

export interface Cluster {
  id: string;
  name: string;
  color: string;
}

export interface KBGraph {
  nodes: KBNode[];
  edges: KBEdge[];
  clusters: Cluster[];
  related: Record<string, string[]>;
}
