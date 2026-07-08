/**
 * LLM provider + model selection. The active provider/model is read
 * at every turn by the session host and surfaced in the StatusBar.
 * Persists to localStorage so the user's choice survives a reload.
 *
 * Selection logic on first load:
 *   - whichever provider has a stored selection wins;
 *   - otherwise default to Gemini (free-tier friendly, single key).
 * Both provider and model identity live here; the BYOK slot lookup
 * lives in `lib/llm/byok.ts` and the provider implementation in
 * `lib/llm/registry.ts`.
 */
import { create } from 'zustand';
import type { ByokProviderId } from '~/lib/llm/byok';

const STORAGE_KEY = 'pyric.playground.llm.selection';
const OPENROUTER_EFFORT_STORAGE_KEY = 'pyric.playground.openrouter.effort';
const GEMINI_EFFORT_STORAGE_KEY = 'pyric.playground.gemini.effort';

export type ProviderId = ByokProviderId; // 'gemini' | 'openrouter' | 'ollama'

/** Provider-level thinking effort. For Gemini, `off` omits
 *  `thinkingConfig`; `low`/`medium`/`high` map to Gemini 3.x
 *  `thinkingLevel` or Gemini 2.5 `thinkingBudget`. For OpenRouter,
 *  `off` sends `reasoning: { enabled: false }`; the other values map
 *  through OpenRouter's unified reasoning abstraction. */
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';

interface Selection {
  providerId: ProviderId;
  modelId: string;
}

function readSelection(): Selection | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Selection;
    if (!parsed.providerId || !parsed.modelId) return null;
    return parsed;
  } catch (e) {
    console.warn('[llm] localStorage read failed for selection:', e);
    return null;
  }
}

function writeSelection(s: Selection): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch (e) {
    console.warn('[llm] localStorage write failed for selection:', e);
  }
}

const VALID_EFFORTS: ReadonlyArray<ReasoningEffort> = ['off', 'low', 'medium', 'high'];

function readEffort(storageKey: string, fallback: ReasoningEffort): ReasoningEffort {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw && VALID_EFFORTS.includes(raw as ReasoningEffort)) {
      return raw as ReasoningEffort;
    }
  } catch (e) {
    console.warn('[llm] localStorage read failed for effort:', e);
  }
  return fallback;
}

function writeEffort(storageKey: string, e: ReasoningEffort): void {
  try {
    window.localStorage.setItem(storageKey, e);
  } catch (err) {
    console.warn('[llm] localStorage write failed for effort:', err);
  }
}

interface LlmState {
  providerId: ProviderId;
  modelId: string;
  /** OpenRouter reasoning / thinking budget control. */
  openrouterEffort: ReasoningEffort;
  /** Gemini thinking-level control. Defaults to low, matching the old hidden setting. */
  geminiEffort: ReasoningEffort;
  setProvider(id: ProviderId, modelId: string): void;
  setModel(id: string): void;
  setOpenrouterEffort(e: ReasoningEffort): void;
  setGeminiEffort(e: ReasoningEffort): void;
  setReasoningEffortForProvider(providerId: ProviderId, e: ReasoningEffort): void;
}

const initial: Selection = readSelection() ?? {
  providerId: 'gemini',
  modelId: 'gemini-3.5-flash',
};

export const useLlmStore = create<LlmState>()((set) => ({
  providerId: initial.providerId,
  modelId: initial.modelId,
  openrouterEffort: readEffort(OPENROUTER_EFFORT_STORAGE_KEY, 'medium'),
  geminiEffort: readEffort(GEMINI_EFFORT_STORAGE_KEY, 'low'),
  setProvider: (providerId, modelId) => {
    writeSelection({ providerId, modelId });
    set({ providerId, modelId });
  },
  setModel: (modelId) => {
    set((s) => {
      writeSelection({ providerId: s.providerId, modelId });
      return { modelId };
    });
  },
  setOpenrouterEffort: (openrouterEffort) => {
    writeEffort(OPENROUTER_EFFORT_STORAGE_KEY, openrouterEffort);
    set({ openrouterEffort });
  },
  setGeminiEffort: (geminiEffort) => {
    writeEffort(GEMINI_EFFORT_STORAGE_KEY, geminiEffort);
    set({ geminiEffort });
  },
  setReasoningEffortForProvider: (providerId, effort) => {
    if (providerId === 'gemini') {
      writeEffort(GEMINI_EFFORT_STORAGE_KEY, effort);
      set({ geminiEffort: effort });
      return;
    }
    if (providerId === 'openrouter') {
      writeEffort(OPENROUTER_EFFORT_STORAGE_KEY, effort);
      set({ openrouterEffort: effort });
    }
  },
}));
