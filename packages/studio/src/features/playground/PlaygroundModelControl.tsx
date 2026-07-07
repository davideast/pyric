import { useEffect, useMemo, useState } from 'react';
import type { PlaygroundCommandMessage } from './PlaygroundSurface.js';

type PlaygroundProviderId = 'gemini' | 'openrouter' | 'ollama' | 'llamaServer' | 'claude';
type PlaygroundReasoningEffort = 'off' | 'low' | 'medium' | 'high';

interface ModelDef {
  id: string;
  label: string;
}

interface ProviderDef {
  id: PlaygroundProviderId;
  label: string;
  defaultModelId: string;
  models: readonly ModelDef[];
}

const STORAGE_KEY = 'pyric.playground.llm.selection';
const EFFORT_KEY = 'pyric.playground.openrouter.effort';

const PROVIDERS: readonly ProviderDef[] = [
  {
    id: 'gemini',
    label: 'Gemini',
    defaultModelId: 'gemini-3.5-flash',
    models: [
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
      { id: 'gemini-3.1-flash-lite', label: '3.1 Flash Lite' },
      { id: 'gemini-3-flash-preview', label: '3 Flash Preview' },
      { id: 'gemini-3.1-pro-preview', label: '3.1 Pro Preview' },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultModelId: 'anthropic/claude-opus-4.7',
    models: [
      { id: 'anthropic/claude-opus-4.7', label: 'Claude Opus 4.7' },
      { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' },
      { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
      { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5' },
      { id: 'openai/gpt-5.5', label: 'GPT-5.5' },
      { id: 'moonshotai/kimi-k2.7-code', label: 'Kimi K2.7 Code' },
      { id: 'z-ai/glm-5.1', label: 'GLM 5.1' },
      { id: 'z-ai/glm-5.2', label: 'GLM 5.2' },
      { id: 'minimax/minimax-m3', label: 'MiniMax M3' },
      { id: 'google/gemma-4-31b-it', label: 'Gemma 4 31B IT' },
      { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek v4 Pro' },
      { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek v4 Flash' },
    ],
  },
  {
    id: 'ollama',
    label: 'Ollama',
    defaultModelId: 'llama3.1:8b',
    models: [
      { id: 'llama3.1:8b', label: 'Llama 3.1 8B' },
      { id: 'llama3.1:70b', label: 'Llama 3.1 70B' },
      { id: 'qwen2.5-coder', label: 'Qwen 2.5 Coder' },
      { id: 'mistral', label: 'Mistral' },
      { id: 'phi3', label: 'Phi-3' },
    ],
  },
  {
    id: 'llamaServer',
    label: 'llama.cpp',
    defaultModelId: 'default',
    models: [{ id: 'default', label: 'Loaded model' }],
  },
  {
    id: 'claude',
    label: 'Claude CLI',
    defaultModelId: 'claude-sonnet-4-6',
    models: [
      { id: 'claude-fable-5', label: 'Fable 5' },
      { id: 'claude-opus-4-8', label: 'Opus 4.8' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    ],
  },
];

const PROVIDER_BY_ID = Object.fromEntries(PROVIDERS.map((provider) => [provider.id, provider])) as Record<
  PlaygroundProviderId,
  ProviderDef
>;

const EFFORTS: readonly { id: PlaygroundReasoningEffort; label: string }[] = [
  { id: 'off', label: 'no thinking' },
  { id: 'low', label: 'low' },
  { id: 'medium', label: 'medium' },
  { id: 'high', label: 'high' },
];

interface Selection {
  providerId: PlaygroundProviderId;
  modelId: string;
  effort: PlaygroundReasoningEffort;
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function isProviderId(value: unknown): value is PlaygroundProviderId {
  return (
    value === 'gemini' ||
    value === 'openrouter' ||
    value === 'ollama' ||
    value === 'llamaServer' ||
    value === 'claude'
  );
}

function readSelection(): Selection {
  const fallback = PROVIDER_BY_ID.gemini;
  const ls = safeLocalStorage();
  let provider = fallback;
  let modelId = fallback.defaultModelId;
  let effort: PlaygroundReasoningEffort = 'medium';
  try {
    const raw = ls?.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { providerId?: unknown; modelId?: unknown };
      if (isProviderId(parsed.providerId)) {
        provider = PROVIDER_BY_ID[parsed.providerId];
        modelId =
          typeof parsed.modelId === 'string' &&
          provider.models.some((model) => model.id === parsed.modelId)
            ? parsed.modelId
            : provider.defaultModelId;
      }
    }
  } catch {
    /* ignore malformed persisted selection */
  }
  const rawEffort = ls?.getItem(EFFORT_KEY);
  if (rawEffort === 'off' || rawEffort === 'low' || rawEffort === 'medium' || rawEffort === 'high') {
    effort = rawEffort;
  }
  return { providerId: provider.id, modelId, effort };
}

function persistSelection(selection: Selection): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  ls.setItem(
    STORAGE_KEY,
    JSON.stringify({ providerId: selection.providerId, modelId: selection.modelId }),
  );
  ls.setItem(EFFORT_KEY, selection.effort);
}

export function PlaygroundModelControl({
  onCommand,
}: {
  onCommand: (message: PlaygroundCommandMessage) => void;
}) {
  const [selection, setSelection] = useState(readSelection);
  const provider = PROVIDER_BY_ID[selection.providerId];
  const models = provider.models;
  const showEffort = selection.providerId === 'openrouter' || selection.providerId === 'claude';

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === EFFORT_KEY) setSelection(readSelection());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const commit = useMemo(
    () => (next: Selection) => {
      persistSelection(next);
      setSelection(next);
      onCommand({
        type: 'pyric:playground:set-model',
        providerId: next.providerId,
        modelId: next.modelId,
        effort: next.effort,
      });
    },
    [onCommand],
  );

  return (
    <div className="studio-playground-model" aria-label="Playground model">
      <select
        value={selection.providerId}
        aria-label="Playground provider"
        onChange={(event) => {
          const providerId = event.target.value as PlaygroundProviderId;
          const nextProvider = PROVIDER_BY_ID[providerId];
          commit({
            ...selection,
            providerId,
            modelId: nextProvider.defaultModelId,
          });
        }}
      >
        {PROVIDERS.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      <select
        value={selection.modelId}
        aria-label="Playground model"
        onChange={(event) => commit({ ...selection, modelId: event.target.value })}
      >
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.label}
          </option>
        ))}
      </select>
      {showEffort ? (
        <select
          value={selection.effort}
          aria-label="Playground reasoning effort"
          onChange={(event) =>
            commit({
              ...selection,
              effort: event.target.value as PlaygroundReasoningEffort,
            })
          }
        >
          {EFFORTS.map((effort) => (
            <option key={effort.id} value={effort.id}>
              {effort.label}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}
