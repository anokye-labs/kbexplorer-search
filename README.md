# @anokye-labs/kbexplorer-search

Semantic search companion module for [kbexplorer](https://github.com/anokye-labs/kbexplorer-template) — derive, validate, and serve semantic search over knowledge graphs.

## Roles

### Index Production

Reads the kbexplorer content model, derives searchable units from the graph, generates embeddings, and writes checked-in search artifacts. Runs locally, in CI, or in GitHub Actions whenever the knowledge base changes.

```bash
kbexplorer search-index          # extract + embed + write artifacts
kbexplorer search-index --check  # CI drift gate (no API calls)
```

### Index Consumption

Loads checked-in artifacts, builds an efficient vector index, embeds incoming queries, and returns kbexplorer-native results: node IDs, titles, paths, clusters, snippets, scores, and graph-aware context.

```bash
kbexplorer search "how does audit validation work?"
```

## Install

```bash
npm install @anokye-labs/kbexplorer-search
```

## Contract

- **kbexplorer** defines and renders the knowledge graph.
- **kbexplorer-search** derives, validates, and serves semantic search over that graph.

Search artifacts are deterministic, reviewable build outputs tied to the exact version of the kbexplorer graph. The repository owns the semantic search corpus; the service only provides query execution.

## License

MIT
