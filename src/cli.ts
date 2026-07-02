/**
 * `kbexplorer-search` command-line entrypoint.
 *
 * Today this exposes a single command — `serve` — which loads checked-in
 * search artifacts and starts the localhost HTTP search service. This makes the
 * module a first-class runnable in the kbexplorer (kbx) system: the
 * kbexplorer-template SPA points `VITE_SEARCH_SERVICE_URL` at this server, and
 * `kbx search-serve` can delegate here.
 *
 *   npx @anokye-labs/kbexplorer-search serve --dir .search --port 7700
 *
 * The functions here are dependency-injectable so they can be tested without a
 * live embedding provider.
 */

import { resolve } from 'node:path';
import { readArtifacts, readLexicalIndex } from './artifacts.js';
import { createSearchServer, type SearchServer } from './server.js';
import { getProvider } from './providers/index.js';
import type { EmbeddingProvider } from './providers/interface.js';
import type { EmbeddingArtifact } from './types.js';

const DEFAULT_ARTIFACT_DIR = '.search';
const DEFAULT_PORT = 7700;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PROVIDER = 'openai';

/** Parsed options for the `serve` command. */
export interface ServeOptions {
  dir: string;
  port: number;
  host: string;
  provider: string;
  /** Query embedding model. Defaults to the model recorded in the artifacts. */
  model?: string;
  /** Query embedding dimensions. Defaults to the artifact dimensions. */
  dimensions?: number;
  help: boolean;
}

/** Parse `serve` arguments into resolved options (pure, testable). */
export function parseServeArgs(args: string[]): ServeOptions {
  const out: ServeOptions = {
    dir: DEFAULT_ARTIFACT_DIR,
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    provider: DEFAULT_PROVIDER,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--dir') out.dir = args[++i] ?? out.dir;
    else if (a.startsWith('--dir=')) out.dir = a.slice('--dir='.length);
    else if (a === '--port') out.port = parseInt(args[++i] ?? '', 10);
    else if (a.startsWith('--port=')) out.port = parseInt(a.slice('--port='.length), 10);
    else if (a === '--host') out.host = args[++i] ?? out.host;
    else if (a.startsWith('--host=')) out.host = a.slice('--host='.length);
    else if (a === '--provider') out.provider = args[++i] ?? out.provider;
    else if (a.startsWith('--provider=')) out.provider = a.slice('--provider='.length);
    else if (a === '--model') out.model = args[++i];
    else if (a.startsWith('--model=')) out.model = a.slice('--model='.length);
    else if (a === '--dimensions') out.dimensions = parseInt(args[++i] ?? '', 10);
    else if (a.startsWith('--dimensions=')) out.dimensions = parseInt(a.slice('--dimensions='.length), 10);
  }
  return out;
}

/** Result of starting the serve command. */
export interface StartServeResult {
  server: SearchServer;
  /** The actual bound port (resolves `--port 0` to an ephemeral port). */
  port: number;
  artifact: EmbeddingArtifact;
}

/** Dependency overrides for {@link startServe} (used by tests). */
export interface StartServeDeps {
  /** Resolve an embedding provider by name. Defaults to the built-in registry. */
  resolveProvider?: (
    name: string,
    config: { model: string; dimensions?: number },
  ) => EmbeddingProvider;
}

/**
 * Load artifacts and start the HTTP search server.
 *
 * The query embedding model/dimensions default to the values recorded in the
 * artifacts so query vectors live in the same space as the indexed vectors.
 */
export async function startServe(
  opts: ServeOptions,
  deps: StartServeDeps = {},
): Promise<StartServeResult> {
  const dir = resolve(opts.dir);
  const artifact = readArtifacts(dir);
  if (!artifact) {
    throw new Error(
      `No search artifacts found in ${dir}. Run \`kbx search-index\` to build them first.`,
    );
  }

  const model = opts.model ?? artifact.meta.model;
  const dimensions = opts.dimensions ?? artifact.meta.dimensions;
  const resolveProvider = deps.resolveProvider ?? getProvider;
  const provider = resolveProvider(opts.provider, { model, dimensions });

  // Load the BM25 term index if present so a lexical provider can be served
  // with the BM25 engine (an embedding provider ignores it). Without this the
  // server would fall back to the cosine engine and 500 on every lexical query.
  const lexicalIndex = readLexicalIndex(dir) ?? undefined;

  const server = createSearchServer(artifact, provider, {
    port: opts.port,
    host: opts.host,
    lexicalIndex,
  });
  const port = await server.start();
  return { server, port, artifact };
}

function printHelp(): void {
  console.log(`
  kbexplorer-search — semantic search service for the kbexplorer (kbx) system

  Usage: kbexplorer-search <command> [options]

  Commands:
    serve     Start the localhost HTTP search service from checked-in artifacts

  Run "kbexplorer-search serve --help" for serve options.
`);
}

function printServeHelp(): void {
  console.log(`
  kbexplorer-search serve — start the localhost HTTP search service

  Usage: kbexplorer-search serve [options]

  Loads checked-in artifacts (index-meta.json, units.json, vectors.json) and
  serves GET /health, GET /stats, and POST /search. Point the template's
  VITE_SEARCH_SERVICE_URL at the printed URL.

  Options:
    --dir <path>          Artifact directory (default: ${DEFAULT_ARTIFACT_DIR})
    --port <n>            Port to listen on (default: ${DEFAULT_PORT})
    --host <host>         Host/interface to bind (default: ${DEFAULT_HOST})
    --provider <name>     Embedding provider for queries (default: ${DEFAULT_PROVIDER})
    --model <id>          Query model (default: the indexed model from artifacts)
    --dimensions <n>      Query dimensions (default: the indexed dimensions)
    -h, --help            Show this help

  The query provider must match the one used to build the index. The OpenAI
  provider requires OPENAI_API_KEY in the environment. Use --provider lexical
  for the zero-credential BM25 index (no API key, no network) — the server
  serves it from lexical-index.json with BM25 scoring.
`);
}

/** CLI entrypoint. Resolves once a long-running command is listening. */
export async function main(argv: string[]): Promise<void> {
  const command = argv[0];

  if (!command || command === '-h' || command === '--help') {
    printHelp();
    return;
  }

  if (command === 'serve') {
    const opts = parseServeArgs(argv.slice(1));
    if (opts.help) {
      printServeHelp();
      return;
    }
    const { port, artifact } = await startServe(opts);
    console.log(
      `kbexplorer-search: serving ${artifact.meta.unitCount} units ` +
        `(model ${artifact.meta.model}, ${artifact.meta.dimensions}d) at ` +
        `http://${opts.host}:${port}`,
    );
    console.log('  GET  /health   GET /stats   POST /search');
    // Resolves here; the http.Server keeps the event loop alive.
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error('Run "kbexplorer-search --help" for usage.');
  process.exitCode = 1;
}
