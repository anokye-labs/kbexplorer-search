import { describe, it, expect } from 'vitest';
import { registerProvider, getProvider, listProviders } from '../src/providers/index.js';

describe('provider registry', () => {
  it('throws for unknown provider', () => {
    expect(() => getProvider('nonexistent', { model: 'x' })).toThrow(
      'Unknown embedding provider "nonexistent"',
    );
  });

  it('resolves a registered provider', () => {
    registerProvider('test-provider', (config) => ({
      name: 'test-provider',
      model: config.model,
      dimensions: config.dimensions ?? 128,
      async embed(texts) {
        return texts.map(() => Array(128).fill(0));
      },
    }));

    const provider = getProvider('test-provider', { model: 'v1' });
    expect(provider.name).toBe('test-provider');
    expect(provider.model).toBe('v1');
    expect(provider.dimensions).toBe(128);
  });

  it('listProviders returns registered names', () => {
    const names = listProviders();
    expect(names).toContain('openai');
  });
});
