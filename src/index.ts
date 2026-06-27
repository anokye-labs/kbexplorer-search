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
} from './kbexplorer-types.js';

export { extractSearchUnits } from './extract.js';

export { generateEmbeddings, hashText } from './embed.js';
export type { EmbedProgressCallback, GenerateEmbeddingsOptions } from './embed.js';

export {
  writeArtifacts,
  readArtifacts,
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

export { createSearchServer } from './server.js';
export type { ServerConfig, SearchServer } from './server.js';

export { applyGraphRanking } from './graph-ranking.js';
export type {
  GraphRankingConfig,
  RelatedSuggestion,
  GraphRankedResult,
} from './graph-ranking.js';
