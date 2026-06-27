import type { EmbeddingProvider } from './interface.js';

const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIMENSIONS = 1536;
const OPENAI_API_URL = 'https://api.openai.com/v1/embeddings';

/**
 * OpenAI embedding provider.
 *
 * Uses the OpenAI embeddings API. Requires OPENAI_API_KEY in the environment.
 */
export class OpenAIProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly model: string;
  readonly dimensions: number;
  private readonly apiKey: string;

  constructor(config: { model?: string; dimensions?: number }) {
    this.model = config.model || DEFAULT_MODEL;
    this.dimensions = config.dimensions || DEFAULT_DIMENSIONS;
    const key = process.env['OPENAI_API_KEY'];
    if (!key) {
      throw new Error(
        'OpenAI embedding provider requires OPENAI_API_KEY environment variable',
      );
    }
    this.apiKey = key;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const body: Record<string, unknown> = {
      input: texts,
      model: this.model,
    };
    if (this.dimensions !== DEFAULT_DIMENSIONS) {
      body['dimensions'] = this.dimensions;
    }

    const res = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `OpenAI embeddings API error (${res.status}): ${text.slice(0, 200)}`,
      );
    }

    const json = (await res.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    // Sort by index to match input order
    const sorted = json.data.sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  }
}
