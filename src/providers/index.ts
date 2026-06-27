export type { EmbeddingProvider } from './interface.js';
export { registerProvider, getProvider, listProviders } from './registry.js';
export { OpenAIProvider } from './openai.js';

// Register the built-in OpenAI provider
import { registerProvider } from './registry.js';
import { OpenAIProvider } from './openai.js';

registerProvider('openai', (config) => new OpenAIProvider(config));
