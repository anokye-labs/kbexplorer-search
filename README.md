# @anokye-labs/kbexplorer-search

Semantic search companion module for [kbexplorer](https://github.com/anokye-labs/kbexplorer-template) — derive, validate, and serve semantic search over knowledge graphs.

## Roles

### Index Production

Reads the kbexplorer content model, derives searchable units from the graph, generates embeddings, and writes checked-in search artifacts. Runs locally, in CI, or in GitHub Actions whenever the knowledge base changes.

Driven through the [`kbx` CLI](https://github.com/anokye-labs/kbexplorer-cli), which builds the graph from `content/` and delegates to this module:

```bash
kbx search-index          # extract + embed + write artifacts to .search/
kbx search-index --check  # CI drift gate (no API calls)
```

### Index Consumption

Loads checked-in artifacts, builds an efficient vector index, embeds incoming queries, and returns kbexplorer-native results: node IDs, titles, paths, clusters, snippets, scores, and graph-aware context.

```bash
kbx search "how does audit validation work?"
```

## Search providers

| Provider | Credentials | Index artifacts | Query scoring |
|----------|-------------|------------------|----------------|
| `openai` (default) | `OPENAI_API_KEY` | `units.json` + `vectors.json` + `index-meta.json` | Cosine similarity |
| `lexical` | none — no network, no API key | `units.json` + `vectors.json` (empty) + `index-meta.json` (`providerType: "lexical"`) + `lexical-index.json` | Okapi BM25 |

The `lexical` provider (`src/providers/lexical.ts`) is a deterministic, zero-credential BM25 term index — it backs the `kbx` onboarding "local" search mode, which has no API key available. Build and query it directly from the library API:

```ts
import { extractSearchUnits, buildLexicalIndex, createLexicalSearchEngine, writeLexicalArtifacts } from '@anokye-labs/kbexplorer-search';

const units = extractSearchUnits(graph);
const index = buildLexicalIndex(units);        // deterministic BM25 term index
writeLexicalArtifacts('.search', units, index, contentHash); // same checked-in shape as embedding builds

const engine = createLexicalSearchEngine(units, index);
const results = await engine.search('how does audit validation work?'); // same SearchResult shape as the cosine engine
```

`lexical-index.json` is additive to the standard artifact set, so `readArtifacts`/`checkDrift` (the `--check` drift gate) work unchanged against a lexical index directory. `LexicalProvider` is also registered in the provider registry (`getProvider('lexical', ...)` / `listProviders()`) for discovery; its `embed()` intentionally throws, since BM25 needs corpus-wide statistics that a stateless per-call embedding cannot carry — the real query path is `createLexicalSearchEngine`.

## Running the search service

The browser SPA ([kbexplorer-template](https://github.com/anokye-labs/kbexplorer-template)) consumes search over HTTP. Start the localhost service straight from this package — no extra wiring needed:

```bash
# from a repo that has checked-in .search/ artifacts
npx @anokye-labs/kbexplorer-search serve --dir .search --port 7700
# requires OPENAI_API_KEY (or another configured provider) to embed queries
```

Then point the template at it:

```bash
VITE_SEARCH_SERVICE_URL=http://127.0.0.1:7700 npm run dev   # in kbexplorer-template
```

### HTTP contract

| Method & path | Body | Response |
|---------------|------|----------|
| `GET /health` | — | `{ status, unitCount, model }` |
| `GET /stats`  | — | `{ unitCount, model, dimensions, contentHash, version }` |
| `POST /search`| `{ query, limit?, cluster?, entityType?, minScore?, graphRanking? }` | `{ results: SearchResult[], suggestions: RelatedSuggestion[] }` |

When `graphRanking: true`, results are re-ranked with graph structure and `suggestions` (related graph neighbors not already in the result set) are returned; otherwise `suggestions` is `[]`.

## Install

```bash
npm install @anokye-labs/kbexplorer-search
```

You normally don't install this directly — the `kbx` CLI depends on it for index production and queries, and the template talks to the `serve` service over HTTP. Install it directly only when embedding the library API (`createSearchEngine`, `createSearchServer`, `extractSearchUnits`, …) in your own tooling.

## How it fits the kbx system

- [**kbexplorer-core**](https://github.com/anokye-labs/kbexplorer-core) — the shared graph contracts (`KBNode` / `KBEdge` / `KBGraph`). This module consumes them to derive `SearchUnit`s.
- [**kbexplorer-cli** (`kbx`)](https://github.com/anokye-labs/kbexplorer-cli) — builds the graph from local content and drives `search-index` / `search`.
- [**kbexplorer-template**](https://github.com/anokye-labs/kbexplorer-template) — the SPA; calls `POST /search` on the `serve` service via `VITE_SEARCH_SERVICE_URL`.

## Contract

- **kbexplorer** defines and renders the knowledge graph.
- **kbexplorer-search** derives, validates, and serves semantic search over that graph.

Search artifacts are deterministic, reviewable build outputs tied to the exact version of the kbexplorer graph. The repository owns the semantic search corpus; the service only provides query execution.

## Access labels

The index-build path respects access labels carried on nodes/edges
(`KBAccessLabel { classification, visibility, labels[] }`). kbx **labels**; the
host **enforces** — search performs **no** principal evaluation.

- **Default-SAFE (`exclude`):** nodes whose `classification` is `confidential`,
  `restricted`, or `unknown`, or whose `visibility` is `private`, produce **no**
  `SearchUnit` and **no** vector. They never reach `units.json`/`vectors.json`,
  so even titles cannot leak via search. `public`/`internal` stay indexed.
- **Opt-in host-predicate filtered (`include`):** restricted units are indexed
  with their `access` label attached so a host can filter at query time; search
  still evaluates no principals.

Exclusion is a pure function of `(label, config)` — no timestamps, no
randomness — so artifacts stay byte-identical and the `--check` drift gate stays
green. Override the policy via `AccessExclusionConfig` (`mode`,
`excludedClassifications`, `excludedVisibilities`).

## License

MIT
