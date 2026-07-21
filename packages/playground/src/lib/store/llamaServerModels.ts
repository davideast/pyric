/** Live llama.cpp model list backed by `GET ${baseUrl}/v1/models`. */
import { create } from 'zustand';
import type { ModelDef } from '~/lib/llm/gemini';
import {
  FALLBACK_LLAMA_SERVER_MODELS,
  fetchLlamaServerModels,
  resolveConfiguredLlamaServerBaseUrl,
  resolveLocalLlamaServerProxyBaseUrl,
  useLlamaServerTransportBaseUrl,
} from '~/lib/llm/llama-server';

export type LlamaServerModelsStatus = 'idle' | 'loading' | 'ready' | 'error';

interface LlamaServerModelsState {
  models: readonly ModelDef[];
  status: LlamaServerModelsStatus;
  baseUrl: string | null;
  error: string | null;
  refresh: () => Promise<void>;
}

export const useLlamaServerModelsStore = create<LlamaServerModelsState>((set, get) => ({
  models: FALLBACK_LLAMA_SERVER_MODELS,
  status: 'idle',
  baseUrl: null,
  error: null,
  async refresh() {
    if (get().status === 'loading') return;
    const configuredBaseUrl = resolveConfiguredLlamaServerBaseUrl();
    const proxyBaseUrl = resolveLocalLlamaServerProxyBaseUrl();
    const baseUrl = proxyBaseUrl ?? configuredBaseUrl;
    set({ status: 'loading', error: null });
    try {
      const models = await fetchLlamaServerModels(baseUrl);
      useLlamaServerTransportBaseUrl(proxyBaseUrl);
      set({
        models: models.length > 0 ? models : FALLBACK_LLAMA_SERVER_MODELS,
        baseUrl,
        status: 'ready',
        error: null,
      });
    } catch (error) {
      set({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
}));
