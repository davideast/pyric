import { afterEach, describe, expect, test } from 'bun:test';
import { fetchOpenRouterModelMetadata } from './openrouter-models';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('OpenRouter model metadata', () => {
  test('loads context limits and converts per-token prompt pricing to per-million pricing', async () => {
    const signal = new AbortController().signal;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://openrouter.ai/api/v1/models');
      expect(init?.signal).toBe(signal);
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'openai/gpt-5.5',
              name: 'GPT 5.5',
              context_length: 258_000,
              top_provider: { context_length: 200_000 },
              pricing: {
                prompt: '0.0000015',
                input_cache_read: '0.0000002',
              },
            },
            {
              id: 'free/model',
              pricing: { prompt: 0 },
            },
            {
              name: 'ignored without id',
              pricing: { prompt: '1' },
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const models = await fetchOpenRouterModelMetadata(signal);

    expect(models['openai/gpt-5.5']).toMatchObject({
      id: 'openai/gpt-5.5',
      label: 'GPT 5.5',
      contextWindowTokens: 200_000,
      promptPricePerMillion: 1.5,
    });
    expect(models['openai/gpt-5.5']?.cacheReadPricePerMillion).toBeCloseTo(0.2);
    expect(models['free/model']?.promptPricePerMillion).toBe(0);
    expect(models['ignored without id']).toBeUndefined();
  });

  test('throws with upstream status details', async () => {
    globalThis.fetch = (async () =>
      new Response('nope', { status: 503, statusText: 'Unavailable' })) as typeof fetch;

    await expect(fetchOpenRouterModelMetadata()).rejects.toThrow(
      'OpenRouter models returned 503: nope',
    );
  });
});
