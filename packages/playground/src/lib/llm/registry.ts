/**
 * Provider registry — single source of truth for "what providers
 * exist and which model lists do they expose." The session host
 * picks the active provider from here at every turn; the ModelPicker
 * UI renders the menu from here; the ApiKeyForm asks for a key per
 * provider def.
 */
import type { CallbackProvider } from '@inbrowser/agent';
import type { ByokSlot } from '~/lib/llm/byok';
import { BYOK_SLOTS, type ByokProviderId } from '~/lib/llm/byok';
import {
  geminiProvider,
  GEMINI_MODELS,
  DEFAULT_GEMINI_MODEL,
  type ModelDef,
} from '~/lib/llm/gemini';
import {
  openrouterProvider,
  OPENROUTER_MODELS,
  DEFAULT_OPENROUTER_MODEL,
} from '~/lib/llm/openrouter';
import {
  ollamaProvider,
  OLLAMA_MODELS,
  DEFAULT_OLLAMA_MODEL,
} from '~/lib/llm/ollama';
import {
  llamaServerProvider,
  LLAMA_SERVER_MODELS,
  DEFAULT_LLAMA_SERVER_MODEL,
} from '~/lib/llm/llama-server';

export type ProviderId = ByokProviderId;

export interface ProviderDef {
  id: ProviderId;
  label: string;
  provider: CallbackProvider;
  byok: ByokSlot;
  models: readonly ModelDef[];
  defaultModelId: string;
}

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    provider: geminiProvider,
    byok: BYOK_SLOTS.gemini,
    models: GEMINI_MODELS,
    defaultModelId: DEFAULT_GEMINI_MODEL,
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    provider: openrouterProvider,
    byok: BYOK_SLOTS.openrouter,
    models: OPENROUTER_MODELS,
    defaultModelId: DEFAULT_OPENROUTER_MODEL,
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama',
    provider: ollamaProvider,
    byok: BYOK_SLOTS.ollama,
    models: OLLAMA_MODELS,
    defaultModelId: DEFAULT_OLLAMA_MODEL,
  },
  llamaServer: {
    id: 'llamaServer',
    label: 'llama.cpp server',
    provider: llamaServerProvider,
    byok: BYOK_SLOTS.llamaServer,
    models: LLAMA_SERVER_MODELS,
    defaultModelId: DEFAULT_LLAMA_SERVER_MODEL,
  },
};

/** Picker order for the supported Playground providers. */
export const PROVIDER_LIST: readonly ProviderDef[] = Object.values(PROVIDERS);
