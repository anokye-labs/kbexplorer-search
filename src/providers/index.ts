export type { EmbeddingProvider } from './interface.js';
export { registerProvider, getProvider, listProviders } from './registry.js';
export { OpenAIProvider } from './openai.js';
export {
  LexicalProvider,
  LEXICAL_PROVIDER_NAME,
  tokenize,
  buildLexicalIndex,
  scoreLexicalQuery,
  createLexicalSearchEngine,
} from './lexical.js';
export type { LexicalIndexOptions } from './lexical.js';

// Register the built-in providers
import { registerProvider } from './registry.js';
import { OpenAIProvider } from './openai.js';
import { LexicalProvider, LEXICAL_PROVIDER_NAME } from './lexical.js';

registerProvider('openai', (config) => new OpenAIProvider(config));
registerProvider(LEXICAL_PROVIDER_NAME, (config) => new LexicalProvider(config));
