/**
 * Compact provider+model picker. Rendered in the TopBar (desktop) or
 * inside the API-key modal (mobile, where the TopBar is tight). Two
 * dropdowns: provider on the left, model on the right.
 *
 * Switching the provider auto-selects that provider's default model.
 * Switching the model preserves the active provider. Both flows
 * persist via `useLlmStore`.
 *
 * No surrounding chrome — the host decides whether to wrap in a
 * card / strip. The picker just renders the two selects with
 * playground-palette styling.
 */
import { useEffect } from 'react';
import { PROVIDER_LIST, PROVIDERS, type ProviderId } from '~/lib/llm/registry';
import { useLlmStore, type ReasoningEffort } from '~/lib/store/llm';
import { useOllamaModelsStore } from '~/lib/store/ollamaModels';

const EFFORT_OPTIONS: { value: ReasoningEffort; label: string }[] = [
  { value: 'off', label: 'no thinking' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
];

export function ModelPicker() {
  const providerId = useLlmStore((s) => s.providerId);
  const modelId = useLlmStore((s) => s.modelId);
  const openrouterEffort = useLlmStore((s) => s.openrouterEffort);
  const geminiEffort = useLlmStore((s) => s.geminiEffort);
  const setProvider = useLlmStore((s) => s.setProvider);
  const setModel = useLlmStore((s) => s.setModel);
  const setReasoningEffortForProvider = useLlmStore((s) => s.setReasoningEffortForProvider);

  const ollamaModels = useOllamaModelsStore((s) => s.models);
  const ollamaStatus = useOllamaModelsStore((s) => s.status);
  const ollamaError = useOllamaModelsStore((s) => s.error);
  const refreshOllama = useOllamaModelsStore((s) => s.refresh);

  // Discover the live model catalog whenever Ollama is the active
  // provider and we haven't fetched yet. Cheap enough to also re-run
  // on provider switches into Ollama (the store guards against
  // concurrent loads).
  useEffect(() => {
    if (providerId === 'ollama' && ollamaStatus === 'idle') {
      void refreshOllama();
    }
  }, [providerId, ollamaStatus, refreshOllama]);

  // If the live catalog arrives and the user's persisted modelId
  // isn't in it (e.g. they had `llama3.1:8b` selected but the daemon
  // doesn't have it pulled), snap to the first real model so the
  // picker and the inference call agree on what's selected.
  useEffect(() => {
    if (providerId !== 'ollama' || ollamaStatus !== 'ready') return;
    if (ollamaModels.length === 0) return;
    if (!ollamaModels.some((m) => m.id === modelId)) {
      setModel(ollamaModels[0]!.id);
    }
  }, [providerId, ollamaStatus, ollamaModels, modelId, setModel]);

  const activeProvider = PROVIDERS[providerId];
  const modelsForPicker =
    providerId === 'ollama' ? ollamaModels : activeProvider.models;
  const showEffort = providerId === 'gemini' || providerId === 'openrouter';
  const selectedEffort = providerId === 'gemini' ? geminiEffort : openrouterEffort;

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <select
        value={providerId}
        onChange={(e) => {
          const nextId = e.target.value as ProviderId;
          const def = PROVIDERS[nextId];
          setProvider(nextId, def.defaultModelId);
        }}
        className={[
          'h-7 px-2 rounded-md bg-[#2a2a35] text-soft-white text-[12px] font-mono',
          'border border-[#3a3a45] hover:border-[#4a4a55] transition-colors',
          'focus:outline-none focus:border-soft-white/40',
        ].join(' ')}
        title="LLM provider"
      >
        {PROVIDER_LIST.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <select
        value={modelId}
        onChange={(e) => setModel(e.target.value)}
        className={[
          'h-7 px-2 rounded-md bg-[#2a2a35] text-soft-white text-[12px] font-mono max-w-[180px]',
          'border border-[#3a3a45] hover:border-[#4a4a55] transition-colors',
          'focus:outline-none focus:border-soft-white/40',
        ].join(' ')}
        title="Model"
      >
        {modelsForPicker.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      {providerId === 'ollama' && ollamaStatus === 'error' ? (
        <span
          className="text-[11px] font-mono text-red-400/90 truncate max-w-[200px]"
          title={ollamaError ?? 'Ollama /api/tags request failed'}
        >
          tags: failed
        </span>
      ) : null}
      {providerId === 'ollama' && ollamaStatus === 'loading' ? (
        <span className="text-[11px] font-mono text-soft-white/50">tags: …</span>
      ) : null}
      {showEffort ? (
        <select
          value={selectedEffort}
          onChange={(e) =>
            setReasoningEffortForProvider(providerId, e.target.value as ReasoningEffort)
          }
          className={[
            'h-7 px-2 rounded-md bg-[#2a2a35] text-soft-white text-[12px] font-mono',
            'border border-[#3a3a45] hover:border-[#4a4a55] transition-colors',
            'focus:outline-none focus:border-soft-white/40',
          ].join(' ')}
          title={
            providerId === 'gemini'
              ? "Gemini thinking effort. 'no thinking' omits thinkingConfig; low/medium/high request Gemini thinking."
              : "Reasoning effort (thinking budget per model call). Default medium. ReAct-loop turns make many small calls, so low/medium keeps them fast and cheap. 'no thinking' sends reasoning:{enabled:false} (explicit disable)."
          }
        >
          {EFFORT_OPTIONS.map((e) => (
            <option key={e.value} value={e.value}>
              {e.label}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}
