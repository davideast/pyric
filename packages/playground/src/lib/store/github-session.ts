/**
 * Linked GitHub repo for the active playground session — injected into
 * the agent system prompt so publish tools know owner/name.
 */
import { create } from 'zustand';

import type { SessionMeta } from '~/lib/sessions/types';

interface GithubSessionState {
  linkedRepo: SessionMeta['githubRepo'] | null;
  setLinkedRepo(repo: SessionMeta['githubRepo'] | null): void;
}

export const useGithubSessionStore = create<GithubSessionState>()((set) => ({
  linkedRepo: null,
  setLinkedRepo: (linkedRepo) => set({ linkedRepo }),
}));
