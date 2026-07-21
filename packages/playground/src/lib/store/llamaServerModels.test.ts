import { afterEach, describe, expect, test } from 'bun:test';
import { FALLBACK_LLAMA_SERVER_MODELS } from '~/lib/llm/llama-server';
import { useLlamaServerModelsStore } from './llamaServerModels';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  useLlamaServerModelsStore.setState({
    models: FALLBACK_LLAMA_SERVER_MODELS,
    status: 'idle',
    baseUrl: null,
    error: null,
  });
});

describe('llama-server model discovery store', () => {
  test('replaces the fallback with models returned by /v1/models', async () => {
    let requestedUrl = '';
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ data: [{ id: 'ornith-35b' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await useLlamaServerModelsStore.getState().refresh();

    expect(requestedUrl).toBe('http://localhost:8080/v1/models');
    expect(useLlamaServerModelsStore.getState()).toMatchObject({
      models: [{ id: 'ornith-35b', label: 'ornith-35b' }],
      status: 'ready',
      baseUrl: 'http://localhost:8080',
      error: null,
    });
  });
});
