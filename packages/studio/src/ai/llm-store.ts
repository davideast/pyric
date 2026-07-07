/**
 * LLM provider + model selection for Studio AI assists. The active provider /
 * model is read whenever an assist runs and shown in the spine's model selector;
 * it persists to localStorage so the choice survives a reload.
 *
 * Ported from the playground's `lib/store/llm.ts`, but using Studio's
 * module-store + `useSyncExternalStore` pattern (see `features/data/navigation.tsx`)
 * rather than zustand, so Studio takes on no new state-management dependency.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  PROVIDERS,
  type ProviderId,
} from './providers.js';

/** OpenRouter reasoning effort (maps to a thinking budget on thinking models). */
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';

const SELECTION_KEY = 'pyric.playground.llm.selection';
const EFFORT_KEY = 'pyric.playground.openrouter.effort';
const LEGACY_SELECTION_KEY = 'pyric.studio.llm.selection';
const LEGACY_EFFORT_KEY = 'pyric.studio.openrouter.effort';
const VALID_EFFORTS: readonly ReasoningEffort[] = ['off', 'low', 'medium', 'high'];

export interface LlmSelection {
  providerId: ProviderId;
  modelId: string;
  effort: ReasoningEffort;
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function isProviderId(id: string): id is ProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id);
}

function readWithLegacyMigration(
  ls: Storage | null,
  storageKey: string,
  legacyStorageKey: string,
): string | null {
  if (!ls) return null;
  const current = ls.getItem(storageKey);
  if (current !== null) return current;
  const legacy = ls.getItem(legacyStorageKey);
  if (legacy !== null) {
    ls.setItem(storageKey, legacy);
    return legacy;
  }
  return null;
}

/** Read + validate the persisted selection, falling back to the defaults. A
 *  stale model id (provider changed its list) snaps to that provider's default. */
function readInitial(): LlmSelection {
  const ls = safeLocalStorage();
  let providerId: ProviderId = DEFAULT_PROVIDER_ID;
  let modelId = DEFAULT_MODEL_ID;
  let effort: ReasoningEffort = 'medium';

  try {
    const raw = readWithLegacyMigration(ls, SELECTION_KEY, LEGACY_SELECTION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { providerId?: string; modelId?: string };
      if (parsed.providerId && isProviderId(parsed.providerId)) {
        providerId = parsed.providerId;
        const def = PROVIDERS[providerId];
        modelId =
          parsed.modelId && def.models.some((m) => m.id === parsed.modelId)
            ? parsed.modelId
            : def.defaultModelId;
      }
    }
  } catch {
    /* ignore malformed persisted selection */
  }

  const rawEffort = readWithLegacyMigration(ls, EFFORT_KEY, LEGACY_EFFORT_KEY);
  if (rawEffort && VALID_EFFORTS.includes(rawEffort as ReasoningEffort)) {
    effort = rawEffort as ReasoningEffort;
  }

  return { providerId, modelId, effort };
}

// ─── Module store ───────────────────────────────────────────────────────────

let state: LlmSelection = readInitial();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): LlmSelection {
  return state;
}

/** Read the current selection outside React (assists resolve the active model
 *  at run time; also the non-hook read for tests). */
export function getSelection(): LlmSelection {
  return state;
}

function persist(): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    ls.setItem(
      SELECTION_KEY,
      JSON.stringify({ providerId: state.providerId, modelId: state.modelId }),
    );
    ls.setItem(EFFORT_KEY, state.effort);
  } catch {
    /* best-effort persistence */
  }
}

/** Select a provider; the model snaps to that provider's default. */
export function setProvider(providerId: ProviderId): void {
  if (state.providerId === providerId) return;
  state = { ...state, providerId, modelId: PROVIDERS[providerId].defaultModelId };
  persist();
  emit();
}

/** Select a model within the active provider (ignored if not in its list). */
export function setModel(modelId: string): void {
  if (state.modelId === modelId) return;
  if (!PROVIDERS[state.providerId].models.some((m) => m.id === modelId)) return;
  state = { ...state, modelId };
  persist();
  emit();
}

export function setEffort(effort: ReasoningEffort): void {
  if (state.effort === effort) return;
  state = { ...state, effort };
  persist();
  emit();
}

// ─── Hook ─────────────────────────────────────────────────────────────────

export interface LlmSelectionValue extends LlmSelection {
  setProvider: (id: ProviderId) => void;
  setModel: (id: string) => void;
  setEffort: (effort: ReasoningEffort) => void;
}

export function useLlmSelection(): LlmSelectionValue {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setProviderCb = useCallback((id: ProviderId) => setProvider(id), []);
  const setModelCb = useCallback((id: string) => setModel(id), []);
  const setEffortCb = useCallback((effort: ReasoningEffort) => setEffort(effort), []);
  return useMemo<LlmSelectionValue>(
    () => ({
      providerId: snap.providerId,
      modelId: snap.modelId,
      effort: snap.effort,
      setProvider: setProviderCb,
      setModel: setModelCb,
      setEffort: setEffortCb,
    }),
    [snap.providerId, snap.modelId, snap.effort, setProviderCb, setModelCb, setEffortCb],
  );
}
