/**
 * Localhost HTTP search service.
 *
 * Loads checked-in search artifacts and serves semantic queries over HTTP.
 * Intended for local development, CI validation, or lightweight production.
 *
 * Endpoints:
 *   GET  /health          → { status: 'ok', unitCount, model }
 *   POST /search          → { results: SearchResult[] }
 *   GET  /stats           → { unitCount, model, dimensions, contentHash }
 *
 * Uses Node built-in http — no framework dependency.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { EmbeddingProvider } from './providers/interface.js';
import type { EmbeddingArtifact, SearchOptions, SearchResult } from './types.js';
import { createSearchEngine } from './search-engine.js';

export interface ServerConfig {
  port?: number;
  host?: string;
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
        };

        const results: SearchResult[] = await engine.search(body.query, options);
        jsonResponse(res, 200, { results });
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
