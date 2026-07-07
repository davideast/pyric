/**
 * Live Ollama model list backed by `GET ${baseUrl}/api/tags`.
 *
 * Decoupled from `useLlmStore` (which only holds the user's
 * selection) because the model list is async — it depends on
 * whatever daemon `resolveOllamaBaseUrl()` points at. The fallback
 * list from `ollama.ts` seeds `models` so the picker has something
 * to render before the first fetch resolves; `refresh()` replaces it
 * with the daemon's real catalog.
 *
 * Only the ModelPicker calls `refresh()` today — on mount and on
 * provider switch when Ollama becomes active.
 */
import { create } from 'zustand';
import type { ModelDef } from '~/lib/llm/gemini';
import {
  FALLBACK_OLLAMA_MODELS,
  fetchOllamaModels,
  resolveOllamaBaseUrl,
} from '~/lib/llm/ollama';

export type OllamaModelsStatus = 'idle' | 'loading' | 'ready' | 'error';

interface OllamaModelsState {
  models: readonly ModelDef[];
  status: OllamaModelsStatus;
  /** Source-of-truth URL the last successful fetch used; null when
   *  no fetch has succeeded yet. Useful for surfacing "which host
   *  did the picker actually query" in diagnostic UI. */
  baseUrl: string | null;
  error: string | null;
  refresh: () => Promise<void>;
}

export const useOllamaModelsStore = create<OllamaModelsState>((set, get) => ({
  models: FALLBACK_OLLAMA_MODELS,
  status: 'idle',
  baseUrl: null,
  error: null,
  async refresh() {
    if (get().status === 'loading') return;
    const baseUrl = resolveOllamaBaseUrl();
    set({ status: 'loading', error: null });
    try {
      const models = await fetchOllamaModels(baseUrl);
      set({
        models: models.length > 0 ? models : FALLBACK_OLLAMA_MODELS,
        baseUrl,
        status: 'ready',
        error: null,
      });
    } catch (e) {
      set({
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
}));
