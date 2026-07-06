import { create } from 'zustand';
import {
  fetchOpenRouterModelMetadata,
  type OpenRouterModelMeta,
} from '~/lib/llm/openrouter-models';

export type OpenRouterModelsStatus = 'idle' | 'loading' | 'ready' | 'error';

interface OpenRouterModelsState {
  byId: Record<string, OpenRouterModelMeta>;
  status: OpenRouterModelsStatus;
  error: string | null;
  refresh: () => Promise<void>;
}

export const useOpenRouterModelsStore = create<OpenRouterModelsState>((set, get) => ({
  byId: {},
  status: 'idle',
  error: null,
  async refresh() {
    if (get().status === 'loading') return;
    set({ status: 'loading', error: null });
    try {
      const byId = await fetchOpenRouterModelMetadata();
      set({ byId, status: 'ready', error: null });
    } catch (e) {
      set({
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
}));
