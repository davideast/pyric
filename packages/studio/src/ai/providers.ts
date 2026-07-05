/**
 * Provider registry for Studio AI assists: the single source of truth for which
 * providers exist + their model lists. The model selector renders from here; the
 * API-keys settings page asks for a key per provider; `inference.ts` (next
 * increment) builds an `LlmClient` from the active selection + the provider fn.
 *
 * Adapted from the playground's `lib/llm/registry.ts`. Differences:
 *  - Anthropic is a first-class BROWSER provider (the playground only had a
 *    dev-only Claude CLI lane); it is Studio's default.
 *  - The dev-only CLI lane is dropped.
 *  - Config only for now: the `provider` inference fn is added when the
 *    per-provider streaming fns land (Phase 0, next increment). Model ids/labels
 *    are refined then against real API calls.
 */

import {
  createApiKeySlot,
  createBaseUrlSlot,
  type ByokSlot,
} from './byok.js';

export interface ModelDef {
  id: string;
  label: string;
  contextWindowTokens?: number;
}

export type ProviderId = 'anthropic' | 'openrouter' | 'gemini' | 'ollama';

export interface ProviderDef {
  id: ProviderId;
  label: string;
  /** Whether the browser can call the provider directly (Anthropic needs the
   *  SDK allow-browser flag; the rest are browser-native), informs the settings
   *  copy + whether a relay is recommended. */
  browserDirect: boolean;
  byok: ByokSlot;
  models: readonly ModelDef[];
  defaultModelId: string;
}

const ANTHROPIC_MODELS: readonly ModelDef[] = [
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', contextWindowTokens: 200_000 },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', contextWindowTokens: 200_000 },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', contextWindowTokens: 200_000 },
];

const OPENROUTER_MODELS: readonly ModelDef[] = [
  { id: 'anthropic/claude-opus-4.8', label: 'Claude Opus 4.8', contextWindowTokens: 200_000 },
  { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6', contextWindowTokens: 200_000 },
  { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5', contextWindowTokens: 200_000 },
  { id: 'openai/gpt-5.5', label: 'GPT-5.5', contextWindowTokens: 258_000 },
  { id: 'google/gemini-3-pro', label: 'Gemini 3 Pro', contextWindowTokens: 1_000_000 },
  { id: 'z-ai/glm-5.2', label: 'GLM 5.2', contextWindowTokens: 200_000 },
  { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek v4 Pro' },
];

const GEMINI_MODELS: readonly ModelDef[] = [
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', contextWindowTokens: 1_000_000 },
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview', contextWindowTokens: 1_000_000 },
];

const OLLAMA_MODELS: readonly ModelDef[] = [
  { id: 'llama3.1:8b', label: 'Llama 3.1 8B' },
  { id: 'qwen2.5-coder', label: 'Qwen 2.5 Coder' },
  { id: 'mistral', label: 'Mistral' },
];

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  anthropic: {
    id: 'anthropic',
    label: 'Claude (Anthropic)',
    browserDirect: true,
    byok: createApiKeySlot('anthropic', 'Anthropic API key', 'https://console.anthropic.com/settings/keys'),
    models: ANTHROPIC_MODELS,
    defaultModelId: 'claude-opus-4-8',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    browserDirect: true,
    byok: createApiKeySlot('openrouter', 'OpenRouter API key', 'https://openrouter.ai/keys'),
    models: OPENROUTER_MODELS,
    defaultModelId: 'anthropic/claude-opus-4.8',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    browserDirect: true,
    byok: createApiKeySlot('gemini', 'Gemini API key', 'https://aistudio.google.com/apikey'),
    models: GEMINI_MODELS,
    defaultModelId: 'gemini-3.5-flash',
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    browserDirect: true,
    byok: createBaseUrlSlot('ollama', 'Ollama base URL', 'https://ollama.com', 'http://localhost:11434'),
    models: OLLAMA_MODELS,
    defaultModelId: 'llama3.1:8b',
  },
};

/** Menu order: Claude (default) first. */
export const PROVIDER_LIST: readonly ProviderDef[] = [
  PROVIDERS.anthropic,
  PROVIDERS.openrouter,
  PROVIDERS.gemini,
  PROVIDERS.ollama,
];

/** Studio's default selection until the user picks otherwise. */
export const DEFAULT_PROVIDER_ID: ProviderId = 'anthropic';
export const DEFAULT_MODEL_ID = PROVIDERS.anthropic.defaultModelId;

export function providerById(id: ProviderId): ProviderDef {
  return PROVIDERS[id];
}

export function modelsFor(id: ProviderId): readonly ModelDef[] {
  return PROVIDERS[id].models;
}
