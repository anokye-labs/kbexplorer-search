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

Never hardcode a specific embedding API. All embedding calls go through the `EmbeddingProvider` interface. The OpenAI provider is the default; others can be registered via the provider registry. The zero-credential `lexical` provider is registered the same way for discovery, even though its BM25 query path (`buildLexicalIndex` / `createLexicalSearchEngine`) doesn't route through `embed()` — see `providers/lexical.ts`'s module docstring for why.

## Architecture

```
src/
  types.ts              Core type definitions (SearchUnit, SearchResult, LexicalIndex, etc.)
  kbexplorer-types.ts   Thin re-export of @anokye-labs/kbexplorer-core's graph/access types
  extract.ts            KBGraph -> SearchUnit[] extraction pipeline
  access.ts             Access-label exclusion policy for the index-build path
  embed.ts              Batch embedding generation with caching
  artifacts.ts          Deterministic artifact read/write (embedding + lexical)
  drift.ts              CI drift detection gate
  search-engine.ts      Pure-JS cosine similarity search
  faiss-engine.ts       Optional FAISS-accelerated search, falls back to search-engine.ts
  graph-ranking.ts      Graph-aware re-ranking and related-node suggestions
  snippet.ts            Shared snippet truncation used by every search engine
  server.ts             Localhost HTTP search service
  cli.ts                `serve` command — start the HTTP service from artifacts
  providers/
    interface.ts        EmbeddingProvider contract
    openai.ts           OpenAI embedding provider
    lexical.ts          Zero-credential BM25 term index + provider (no API key/network)
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

## GitHub & Work-Item Conventions

Tool-agnostic: `gh` CLI, raw REST/GraphQL, or an MCP GitHub server are all fine — use whichever is available. Sub-issue and blocked-by relationships are GraphQL-only; confirm GraphQL-level access before relying on that structure, since a REST/`gh`-only path can't read or write it.

Reference issues with `refs #N`, never `closes #N`. Closing is a separate, deliberate step taken after verifying the fix — don't let a commit or PR description auto-close.

Before starting work on an issue, check its blocked-by relationships and confirm blockers are actually resolved — not just assumed resolved from surrounding context.

Conventional Commits (`type(scope): description`), atomic — one logical change per commit.

Branch protection: check, don't assume. This repo currently has **no** branch protection configured on `main` (kbexplorer#105) — don't rely on an invariant like "CI must pass before merge" holding here unless you've verified it via the API for this specific repo.

For multi-step or multi-repo work, see kbexplorer-template's `.agents/skills/wbs-builder/` for workback-schedule construction.

## Verification

Before declaring work done, run `npm run build && npm run lint && npm test` and confirm all pass.
