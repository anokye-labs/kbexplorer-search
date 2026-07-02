// Public API
export type {
  SearchUnit,
  EmbeddingVector,
  IndexMeta,
  EmbeddingArtifact,
  SearchResult,
  SearchConfig,
  SearchOptions,
  SearchEngine,
  ResolvedChunkingConfig,
  LexicalPosting,
  LexicalIndex,
} from './types.js';
export { DEFAULT_CHUNKING, DEFAULT_BATCH_SIZE, ARTIFACT_VERSION } from './types.js';

export type {
  KBNode,
  KBEdge,
  KBGraph,
  Cluster,
  Connection,
  NodeSource,
  JsonLd,
  KBAccessLabel,
  KBAccessClassification,
  KBAccessVisibility,
  ExternalRef,
} from './kbexplorer-types.js';

export { extractSearchUnits } from './extract.js';

export {
  DEFAULT_ACCESS_EXCLUSION,
  CLASSIFICATION_SEVERITY,
  ABSENT_CLASSIFICATION_SEVERITY,
  resolveAccessConfig,
  classificationSeverity,
  isExcludedByAccess,
} from './access.js';
export type {
  AccessExclusionConfig,
  AccessExclusionMode,
} from './access.js';

export { generateEmbeddings, hashText } from './embed.js';
export type { EmbedProgressCallback, GenerateEmbeddingsOptions } from './embed.js';

export {
  writeArtifacts,
  readArtifacts,
  writeLexicalIndex,
  readLexicalIndex,
  writeLexicalArtifacts,
  readLexicalArtifacts,
  computeContentHash,
  canonicalStringify,
} from './artifacts.js';

export { checkDrift } from './drift.js';
export type { DriftResult } from './drift.js';

export { createSearchEngine } from './search-engine.js';

export type { EmbeddingProvider } from './providers/interface.js';
export {
  registerProvider,
  getProvider,
  listProviders,
} from './providers/index.js';
export { OpenAIProvider } from './providers/index.js';
export {
  LexicalProvider,
  LEXICAL_PROVIDER_NAME,
  tokenize,
  buildLexicalIndex,
  scoreLexicalQuery,
  createLexicalSearchEngine,
} from './providers/index.js';
export type { LexicalIndexOptions } from './providers/index.js';

export { createSearchServer } from './server.js';
export type { ServerConfig, SearchServer } from './server.js';

export { applyGraphRanking } from './graph-ranking.js';
export type {
  GraphRankingConfig,
  RelatedSuggestion,
  GraphRankedResult,
} from './graph-ranking.js';

export { createFaissEngine } from './faiss-engine.js';
export type { FaissEngineConfig, FaissEngineResult } from './faiss-engine.js';
