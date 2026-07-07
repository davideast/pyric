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
const EFFORT_STORAGE_KEY = 'pyric.playground.openrouter.effort';

export type ProviderId = ByokProviderId; // 'gemini' | 'openrouter' | 'ollama'

/** OpenRouter reasoning effort. `off` sends
 *  `reasoning: { enabled: false }` — explicitly disables reasoning
 *  on Anthropic / DeepSeek / GLM / Kimi / MiniMax thinking models;
 *  just omitting the field falls back to each model's default
 *  thinking budget. `low`/`medium`/`high` set OpenAI o-series
 *  effort; for the non-OpenAI thinking models OpenRouter maps
 *  effort to a thinking-token budget. `medium` is a sensible
 *  default for thinking-capable models. */
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

function readEffort(): ReasoningEffort {
  try {
    const raw = window.localStorage.getItem(EFFORT_STORAGE_KEY);
    if (raw && VALID_EFFORTS.includes(raw as ReasoningEffort)) {
      return raw as ReasoningEffort;
    }
  } catch (e) {
    console.warn('[llm] localStorage read failed for effort:', e);
  }
  return 'medium';
}

function writeEffort(e: ReasoningEffort): void {
  try {
    window.localStorage.setItem(EFFORT_STORAGE_KEY, e);
  } catch (err) {
    console.warn('[llm] localStorage write failed for effort:', err);
  }
}

interface LlmState {
  providerId: ProviderId;
  modelId: string;
  /** OpenRouter-only — Gemini handles thinking-budget elsewhere. */
  openrouterEffort: ReasoningEffort;
  setProvider(id: ProviderId, modelId: string): void;
  setModel(id: string): void;
  setOpenrouterEffort(e: ReasoningEffort): void;
}

const initial: Selection = readSelection() ?? {
  providerId: 'gemini',
  modelId: 'gemini-3.5-flash',
};

export const useLlmStore = create<LlmState>()((set) => ({
  providerId: initial.providerId,
  modelId: initial.modelId,
  openrouterEffort: readEffort(),
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
    writeEffort(openrouterEffort);
    set({ openrouterEffort });
  },
}));
