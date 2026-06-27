import type { EmbeddingProvider } from './interface.js';

export type ProviderFactory = (config: {
  model: string;
  dimensions?: number;
}) => EmbeddingProvider;

const factories = new Map<string, ProviderFactory>();

/** Register a named provider factory. */
export function registerProvider(name: string, factory: ProviderFactory): void {
  factories.set(name, factory);
}

/** Resolve a provider by name with the given config. Throws if unknown. */
export function getProvider(
  name: string,
  config: { model: string; dimensions?: number },
): EmbeddingProvider {
  const factory = factories.get(name);
  if (!factory) {
    const known = [...factories.keys()].join(', ') || '(none)';
    throw new Error(
      `Unknown embedding provider "${name}". Registered: ${known}`,
    );
  }
  return factory(config);
}

/** List registered provider names. */
export function listProviders(): string[] {
  return [...factories.keys()];
}
