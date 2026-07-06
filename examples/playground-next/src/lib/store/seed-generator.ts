/**
 * Seed-generator card store — separate from chat (UI affordance only).
 */
import { create } from 'zustand';

import type { SeedContextSummary } from '~/lib/seed-generator/context';
import type { SeedProposalV1 } from '~/lib/seed-generator/schema';

export type SeedGenerationState =
  | 'idle'
  | 'streaming'
  | 'ready'
  | 'applying'
  | 'applied'
  | 'discarded'
  | 'errored';

export interface SeedGeneration {
  id: string;
  createdAt: number;
  hint: string;
  rawStream: string;
  parsedProposal: SeedProposalV1 | null;
  contextSummary: SeedContextSummary | null;
  state: SeedGenerationState;
  errorMessage?: string;
}

interface SeedGeneratorState {
  generation: SeedGeneration | null;
  start(hint: string, contextSummary: SeedContextSummary): string;
  appendChunk(id: string, chunk: string): void;
  setParsed(id: string, proposal: SeedProposalV1): void;
  setState(id: string, state: SeedGenerationState): void;
  setError(id: string, message: string): void;
  resetForRetry(id: string): void;
  clear(): void;
}

function genId(): string {
  return `seed_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const useSeedGeneratorStore = create<SeedGeneratorState>()((set) => ({
  generation: null,
  start: (hint, contextSummary) => {
    const id = genId();
    set({
      generation: {
        id,
        createdAt: Date.now(),
        hint,
        rawStream: '',
        parsedProposal: null,
        contextSummary,
        state: 'streaming',
      },
    });
    return id;
  },
  appendChunk: (id, chunk) =>
    set((s) => {
      if (!s.generation || s.generation.id !== id) return s;
      return {
        generation: { ...s.generation, rawStream: s.generation.rawStream + chunk },
      };
    }),
  setParsed: (id, proposal) =>
    set((s) => {
      if (!s.generation || s.generation.id !== id) return s;
      return { generation: { ...s.generation, parsedProposal: proposal } };
    }),
  setState: (id, state) =>
    set((s) => {
      if (!s.generation || s.generation.id !== id) return s;
      return { generation: { ...s.generation, state } };
    }),
  setError: (id, message) =>
    set((s) => {
      if (!s.generation || s.generation.id !== id) return s;
      return {
        generation: { ...s.generation, state: 'errored', errorMessage: message },
      };
    }),
  resetForRetry: (id: string) =>
    set((s) => {
      if (!s.generation || s.generation.id !== id) return s;
      return {
        generation: {
          ...s.generation,
          rawStream: '',
          parsedProposal: null,
          errorMessage: undefined,
          state: 'streaming',
        },
      };
    }),
  clear: () => set({ generation: null }),
}));
