/**
 * Core types for the kbexplorer-search module.
 *
 * SearchUnit is the atomic searchable entity derived from a KBNode.
 * EmbeddingArtifact is the checked-in artifact set (units + vectors + metadata).
 * SearchResult is the kbexplorer-native result returned by queries.
 */

/** A searchable unit derived from a single KBNode (or a chunk of one). */
export interface SearchUnit {
  /** Composite ID: `${nodeId}` for single-chunk, `${nodeId}#${chunkIndex}` for multi-chunk. */
  unitId: string;
  /** Source KBNode.id. */
  nodeId: string;
  /** 0 for single-chunk nodes; increments for each chunk of a long node. */
  chunkIndex: number;
  /** Searchable text content (markdown body with context header prepended). */
  text: string;
  /** Node title. */
  title: string;
  /** Cluster ID. */
  cluster: string;
  /** Source file path (when available from NodeSource). */
  path?: string;
  /** Hierarchy parent node ID. */
  parentId?: string;
  /** Structured node type (e.g. 'person', 'team'). */
  entityType?: string;
  /** Canonical identity URN (e.g. 'kg://person/ada'). */
  identity?: string;
  /** IDs of directly connected nodes. */
  connections: string[];
  /** Extensible metadata bag. */
  metadata: Record<string, unknown>;
}

/** An embedding vector paired with its SearchUnit. */
export interface EmbeddingVector {
  /** Matches SearchUnit.unitId. */
  unitId: string;
  /** Embedding values. */
  vector: number[];
  /** Model that produced this embedding. */
  model: string;
  /** Vector dimensionality. */
  dimensions: number;
}

/** Metadata about the artifact set. */
export interface IndexMeta {
  /** Artifact schema version. */
  version: number;
  /** SHA-256 hash of the canonical source graph. */
  contentHash: string;
  /** Embedding model used. */
  model: string;
  /** Vector dimensionality. */
  dimensions: number;
  /** Number of SearchUnits indexed. */
  unitCount: number;
}

/** The complete checked-in artifact set: metadata + units + vectors. */
export interface EmbeddingArtifact {
  meta: IndexMeta;
  units: SearchUnit[];
  vectors: EmbeddingVector[];
}

/** A semantic search result with kbexplorer-native metadata. */
export interface SearchResult {
  /** Source KBNode.id. */
  nodeId: string;
  /** Node title. */
  title: string;
  /** Cluster ID. */
  cluster: string;
  /** Cosine similarity score (0..1). */
  score: number;
  /** Relevant text excerpt from the matched SearchUnit. */
  snippet: string;
  /** Which chunk matched (0 for single-chunk nodes). */
  chunkIndex: number;
  /** Source file path. */
  path?: string;
  /** Hierarchy parent node ID. */
  parentId?: string;
  /** Canonical identity URN. */
  identity?: string;
  /** Structured node type. */
  entityType?: string;
  /** IDs of directly connected nodes. */
  connections: string[];
  /** Extensible metadata from the SearchUnit. */
  metadata: Record<string, unknown>;
}

/** Configuration for the search module. */
export interface SearchConfig {
  /** Embedding provider and model configuration. */
  embedding: {
    /** Provider name: 'openai' | 'local' | custom string. */
    provider: string;
    /** Model identifier (e.g. 'text-embedding-3-small'). */
    model: string;
    /** Override vector dimensions (provider default when omitted). */
    dimensions?: number;
    /** Number of texts per embedding API call (default: 100). */
    batchSize?: number;
  };
  /** Artifact output configuration. */
  artifacts: {
    /** Directory for checked-in artifacts (relative to repo root). */
    dir: string;
  };
  /** Text chunking configuration. */
  chunking?: {
    /** Maximum tokens per SearchUnit chunk (default: 512). */
    maxTokens?: number;
    /** Overlap tokens between consecutive chunks (default: 64). */
    overlap?: number;
  };
}

/** Options for a search query. */
export interface SearchOptions {
  /** Maximum number of results (default: 5). */
  limit?: number;
  /** Filter results to a specific cluster. */
  cluster?: string;
  /** Filter results to a specific entity type. */
  entityType?: string;
  /** Minimum cosine similarity score (default: 0). */
  minScore?: number;
}

/** Interface for a search engine instance. */
export interface SearchEngine {
  /** Run a semantic search query. */
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
}

/** Chunking configuration with defaults applied. */
export interface ResolvedChunkingConfig {
  maxTokens: number;
  overlap: number;
}

/** Default chunking configuration. */
export const DEFAULT_CHUNKING: ResolvedChunkingConfig = {
  maxTokens: 512,
  overlap: 64,
};

/** Default batch size for embedding generation. */
export const DEFAULT_BATCH_SIZE = 100;

/** Current artifact schema version. */
export const ARTIFACT_VERSION = 1;
