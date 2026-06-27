/** Contract for an embedding provider. */
export interface EmbeddingProvider {
  /** Human-readable provider name. */
  readonly name: string;
  /** Vector dimensionality produced by this provider. */
  readonly dimensions: number;
  /** Model identifier used for this provider instance. */
  readonly model: string;
  /**
   * Embed an array of texts into vectors.
   * Returns one vector per input text, in the same order.
   */
  embed(texts: string[]): Promise<number[][]>;
}
