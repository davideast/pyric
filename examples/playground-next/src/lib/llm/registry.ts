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
import { IS_LOCAL_HOST_BUILD } from '~/lib/env/local-host';
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
  claudeProvider,
  CLAUDE_MODELS,
  DEFAULT_CLAUDE_MODEL,
} from '~/lib/llm/claude';
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
  claude: {
    id: 'claude',
    label: 'Claude (local CLI)',
    provider: claudeProvider,
    byok: BYOK_SLOTS.claude,
    models: CLAUDE_MODELS,
    defaultModelId: DEFAULT_CLAUDE_MODEL,
  },
};

/**
 * Picker order. The Claude lane needs the server process to be the
 * OWNER's machine — it spawns `claude -p` there — so it's available
 * under `astro dev` AND a local prod preview built with
 * PUBLIC_ENABLE_LOCAL_AUTH (the Tailscale phone setup), never in a
 * deployed build (see lib/env/local-host.ts). A persisted 'claude'
 * selection elsewhere still resolves via `PROVIDERS` and fails with
 * the route's clear 404 message.
 */
export const PROVIDER_LIST: readonly ProviderDef[] = Object.values(PROVIDERS).filter(
  (def) => def.id !== 'claude' || IS_LOCAL_HOST_BUILD,
);
