/**
 * Localhost HTTP search service.
 *
 * Loads checked-in search artifacts and serves semantic queries over HTTP.
 * Intended for local development, CI validation, or lightweight production.
 *
 * Endpoints:
 *   GET  /health          → { status: 'ok', unitCount, model }
 *   POST /search          → { results: SearchResult[], suggestions: RelatedSuggestion[] }
 *   GET  /stats           → { unitCount, model, dimensions, contentHash }
 *
 * POST /search accepts { query, limit?, cluster?, entityType?, minScore?,
 * graphRanking? }. When `graphRanking` is true the results are re-ranked with
 * graph structure and `suggestions` (related graph neighbors not in the result
 * set) are returned; otherwise `suggestions` is an empty array.
 *
 * Uses Node built-in http — no framework dependency.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { EmbeddingProvider } from './providers/interface.js';
import type { EmbeddingArtifact, SearchOptions, SearchResult, SearchUnit } from './types.js';
import { createSearchEngine } from './search-engine.js';
import { applyGraphRanking, type RelatedSuggestion } from './graph-ranking.js';

export interface ServerConfig {
  port?: number;
  host?: string;
  /**
   * Host-side, query-time access filter (AF-017/AF-018-M1), forwarded as
   * `SearchOptions.filterUnit` on every `/search` request served by this
   * process. This is a **process-wide, static** predicate configured at
   * `createSearchServer()` call time — a request body cannot carry a
   * function over JSON, so per-request/per-principal enforcement (e.g.
   * evaluating an auth header) is not available through this bundled HTTP
   * server. A host that needs that should call the library API directly
   * (`createSearchEngine`/`createLexicalSearchEngine`/`createFaissEngine`)
   * and pass a fresh `filterUnit` per call.
   *
   * A unit with `access` left `undefined` (no label) is fails-open —
   * treated as public — same as everywhere else in this module.
   */
  filterUnit?: (unit: SearchUnit) => boolean;
}

export interface SearchServer {
  /** The underlying http.Server. */
  server: Server;
  /** Start listening. Resolves with the actual port once bound. */
  start(): Promise<number>;
  /** Gracefully stop the server. */
  stop(): Promise<void>;
}

interface SearchRequestBody {
  query: string;
  limit?: number;
  cluster?: string;
  entityType?: string;
  minScore?: number;
  /**
   * When true, apply graph-aware ranking and return related-node
   * `suggestions` derived from graph structure. Defaults to false so the
   * raw cosine ranking is returned unchanged.
   */
  graphRanking?: boolean;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(json);
}

/**
 * Create a search HTTP server from artifacts and an embedding provider.
 */
export function createSearchServer(
  artifact: EmbeddingArtifact,
  provider: EmbeddingProvider,
  config?: ServerConfig,
): SearchServer {
  const port = config?.port ?? 7700;
  const host = config?.host ?? '127.0.0.1';
  const engine = createSearchEngine(artifact, provider);

  const httpServer = createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      jsonResponse(res, 204, null);
      return;
    }

    const url = new URL(req.url ?? '/', `http://${host}:${port}`);

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        jsonResponse(res, 200, {
          status: 'ok',
          unitCount: artifact.meta.unitCount,
          model: artifact.meta.model,
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/stats') {
        jsonResponse(res, 200, {
          unitCount: artifact.meta.unitCount,
          model: artifact.meta.model,
          dimensions: artifact.meta.dimensions,
          contentHash: artifact.meta.contentHash,
          version: artifact.meta.version,
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/search') {
        const raw = await readBody(req);
        let body: SearchRequestBody;
        try {
          body = JSON.parse(raw) as SearchRequestBody;
        } catch {
          jsonResponse(res, 400, { error: 'Invalid JSON body' });
          return;
        }

        if (!body.query || typeof body.query !== 'string') {
          jsonResponse(res, 400, { error: 'Missing or invalid "query" field' });
          return;
        }

        const options: SearchOptions = {
          limit: body.limit,
          cluster: body.cluster,
          entityType: body.entityType,
          minScore: body.minScore,
          filterUnit: config?.filterUnit,
        };

        const rawResults: SearchResult[] = await engine.search(body.query, options);

        // Graph-aware ranking is opt-in via `graphRanking`. When enabled, the
        // raw cosine results are re-ranked using graph structure and a list of
        // related-node `suggestions` is produced. `suggestions` is always
        // present in the response for a stable client contract.
        let results: SearchResult[] = rawResults;
        let suggestions: RelatedSuggestion[] = [];
        if (body.graphRanking) {
          const ranked = applyGraphRanking(rawResults, artifact.units);
          results = ranked.results;
          suggestions = ranked.suggestions;
        }

        jsonResponse(res, 200, { results, suggestions });
        return;
      }

      jsonResponse(res, 404, { error: 'Not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      jsonResponse(res, 500, { error: message });
    }
  });

  return {
    server: httpServer,
    start(): Promise<number> {
      return new Promise((resolve, reject) => {
        httpServer.on('error', reject);
        httpServer.listen(port, host, () => {
          const addr = httpServer.address();
          const actualPort = typeof addr === 'object' && addr ? addr.port : port;
          resolve(actualPort);
        });
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
