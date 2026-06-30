# Agents — kbexplorer-search

## Stack

Node.js >= 22, TypeScript (strict, ESM), vitest for testing, eslint for linting.

## Critical Rules

### Deterministic Output

All artifact serialization must be deterministic: sorted keys, stable array order, no timestamps, trailing newline. Identical input must produce byte-identical output. This is the foundation of the drift detection gate.

### Content-Hash Keyed

Embeddings are keyed by the SHA-256 hash of their source text. Re-running on unchanged content must skip the embedding API call and reuse cached vectors. This makes index rebuilds incremental and cheap.

### Graph-Aware, Not Text-Only

SearchUnits carry graph metadata (cluster, hierarchy, connections, entity type, identity URN). The embedding text includes a context header so vector similarity captures graph structure, not just prose content.

### No Native Binary as Source of Truth

FAISS or other native indexes are runtime acceleration only. The portable JSON artifact set (units.json + vectors.json + index-meta.json) is the durable source of truth. The native index is rebuilt from artifacts at startup.

### Pluggable Embedding Providers

Never hardcode a specific embedding API. All embedding calls go through the `EmbeddingProvider` interface. The OpenAI provider is the default; others can be registered via the provider registry.

## Architecture

```
src/
  types.ts              Core type definitions (SearchUnit, SearchResult, etc.)
  kbexplorer-types.ts   Inlined kbexplorer types (TODO: switch to @anokye-labs/kbexplorer-core)
  extract.ts            KBGraph -> SearchUnit[] extraction pipeline
  embed.ts              Batch embedding generation with caching
  artifacts.ts          Deterministic artifact read/write
  drift.ts              CI drift detection gate
  search-engine.ts      Pure-JS cosine similarity search
  server.ts             Localhost HTTP search service
  cli.ts                `serve` command — start the HTTP service from artifacts
  providers/
    interface.ts        EmbeddingProvider contract
    openai.ts           OpenAI embedding provider
    registry.ts         Provider name -> factory registry
  index.ts              Public API barrel export
```

## Testing

```bash
npm test              # vitest, all tests
npm run lint          # eslint
npm run typecheck     # tsc --noEmit
npm run build         # tsc -b (produces dist/)
```

## Issue-First Workflow

Every pull request must trace back to a GitHub Issue. Use native issue types (Epic, Feature, Task) and sub-issue/blocked-by relationships via GraphQL.

## Verification

Before declaring work done, run `npm run build && npm run lint && npm test` and confirm all pass.
