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
  /**
   * Access label carried from the source node, populated for every emitted
   * unit whose source node has a label — in both index modes (AF-018-M1).
   * In the default `exclude` mode, access-restricted nodes are dropped
   * entirely, but any surviving labeled unit still carries its label; in the
   * opt-in `include` mode, restricted units are indexed with their label so a
   * host can filter at query time. A node with no label yields `undefined`,
   * the fails-open default treated as public/unlabeled (AF-018-M2). Search
   * itself never evaluates principals.
   */
  access?: import('./kbexplorer-types.js').KBAccessLabel;
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
  /**
   * Which kind of provider produced this artifact set. Omitted (undefined)
   * means the historical default: a dense-vector embedding provider scored
   * with cosine similarity. `'lexical'` marks a zero-credential BM25 term
   * index (see {@link LexicalIndex}), scored without any embedding calls.
   * Additive; absent means 'embedding' and existing artifacts are unaffected.
   */
  providerType?: 'embedding' | 'lexical';
}

/** A single term's occurrence in one indexed SearchUnit. */
export interface LexicalPosting {
  /** Matches SearchUnit.unitId. */
  unitId: string;
  /** Number of occurrences of the term in this unit's text. */
  termFrequency: number;
}

/**
 * Deterministic BM25 term index — the checked-in artifact backing the
 * zero-credential lexical search provider (`lexical-index.json`).
 *
 * Self-describing on purpose: BM25 scoring needs corpus-wide statistics
 * (document frequency via postings length, average document length) that
 * must survive the process boundary between index build and query time (a
 * stateless per-call embedding cannot carry them). Sorted keys / stable
 * array order — no timestamps, no randomness — so two builds of the same
 * units produce byte-identical JSON.
 */
export interface LexicalIndex {
  /** Index schema version. */
  version: number;
  /** BM25 term-frequency saturation parameter. */
  k1: number;
  /** BM25 document-length normalization parameter (0..1). */
  b: number;
  /** Number of indexed documents (SearchUnits). */
  docCount: number;
  /** Average document length across all units, in tokens. */
  avgDocLength: number;
  /** unitId -> document length in tokens. */
  docLengths: Record<string, number>;
  /** term -> postings list, sorted by unitId. */
  postings: Record<string, LexicalPosting[]>;
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
  /**
   * Optional host-side, query-time filter predicate (AF-017/AF-018-M1).
   *
   * `kbx` **labels** units via {@link SearchUnit.access} (only populated in
   * the opt-in `include` index-build mode — see `access.ts`); search itself
   * performs **zero** principal evaluation. This is the hook a host uses to
   * actually enforce those labels at query time: a unit is only scored and
   * eligible for results when `filterUnit(unit)` returns `true`.
   *
   * A unit with `access` left `undefined` (no label at all) is the
   * documented fails-open default — treat it as public unless your
   * predicate says otherwise; this module never invents a stricter default.
   *
   * Applied identically by every engine (`createSearchEngine`,
   * `createLexicalSearchEngine`, `createFaissEngine`), so a host can swap
   * engines without changing how it enforces access.
   */
  filterUnit?: (unit: SearchUnit) => boolean;
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
