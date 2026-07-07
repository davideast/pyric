/**
 * Prompt-enhancer card store.
 *
 * Holds the in-flight + recently-resolved enhancement cards the
 * activity thread renders inline. Kept SEPARATE from `useChatStore`
 * on purpose: enhancement cards are a UI affordance, not LLM messages
 * — they never enter the model's conversation history, and entangling
 * them with the chat shape (roles, tool calls, metrics) would muddy
 * both stores.
 *
 * State machine per card:
 *   streaming  → ready  → approved          (Send to agent path)
 *                       → edited            (Drop into composer for tweaks)
 *                       → discarded         (User said no — tombstone)
 *
 * Only ONE card can be in `streaming` or `ready` at a time (the
 * composer can't queue a second enhancement until the user resolves
 * the first). Resolved cards stay in the list as receipts for the
 * session — they auto-clear on `clear()` alongside the chat store.
 */
import { create } from 'zustand';

export type EnhancementState =
  | 'streaming'
  | 'ready'
  | 'approved'
  | 'edited'
  | 'discarded'
  | 'errored';

export interface Enhancement {
  id: string;
  /** Wall-clock ms; ActivityTab orders cards by this against chat
   *  message timestamps. */
  createdAt: number;
  /** Raw text the user typed before clicking Enhance. */
  rawInput: string;
  /** Enhanced text — appends during streaming, frozen at `ready`. */
  enhancedText: string;
  state: EnhancementState;
  /** Set when `state === 'errored'` so the card can show why. */
  errorMessage?: string;
}

interface EnhancerState {
  enhancements: Enhancement[];
  /** Push a new card in `streaming` state. Returns the generated id
   *  so the caller can stream chunks into it. */
  append(rawInput: string): string;
  appendChunk(id: string, chunk: string): void;
  setState(id: string, state: EnhancementState): void;
  setError(id: string, message: string): void;
  remove(id: string): void;
  clear(): void;
}

function genId(): string {
  return `enh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const useEnhancerStore = create<EnhancerState>()((set) => ({
  enhancements: [],
  append: (rawInput) => {
    const id = genId();
    set((s) => ({
      enhancements: [
        ...s.enhancements,
        {
          id,
          createdAt: Date.now(),
          rawInput,
          enhancedText: '',
          state: 'streaming',
        },
      ],
    }));
    return id;
  },
  appendChunk: (id, chunk) =>
    set((s) => ({
      enhancements: s.enhancements.map((e) =>
        e.id === id ? { ...e, enhancedText: e.enhancedText + chunk } : e,
      ),
    })),
  setState: (id, state) =>
    set((s) => ({
      enhancements: s.enhancements.map((e) =>
        e.id === id ? { ...e, state } : e,
      ),
    })),
  setError: (id, message) =>
    set((s) => ({
      enhancements: s.enhancements.map((e) =>
        e.id === id ? { ...e, state: 'errored', errorMessage: message } : e,
      ),
    })),
  remove: (id) =>
    set((s) => ({
      enhancements: s.enhancements.filter((e) => e.id !== id),
    })),
  clear: () => set({ enhancements: [] }),
}));
