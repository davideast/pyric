/**
 * Project-scope pointer — which real Firebase project the user is
 * working against. Read by the system-prompt builder (deploy guidance
 * changes when a real project is linked) and the diagnostics tools.
 *
 * History: this store used to carry the legacy cloud-save machinery
 * (`saveState`, `currentSessionId`, per-email last-project pointers)
 * for `SessionsModal`. That modal — and the explicit save/load flow
 * against the user's Firebase Storage bucket — was superseded by the
 * local sessions store (`~/lib/sessions/`, ambient autosave; see
 * `~/lib/store/autosave.ts` for the visible status seam), so the
 * orphaned wiring was deleted with it.
 *
 * NOTE: nothing currently sets `currentProjectId` — the deleted modal
 * was the only setter. The deploy flow tracks its own target
 * (`deployTarget` in the workspace store); re-wiring that into this
 * pointer is a known follow-up, kept out of the save/load UX change.
 */
import { create } from 'zustand';

interface SessionStoreState {
  currentProjectId: string | null;
  setCurrentProjectId(projectId: string | null): void;
}

export const useSessionStore = create<SessionStoreState>()((set) => ({
  currentProjectId: null,
  setCurrentProjectId: (projectId) => set({ currentProjectId: projectId }),
}));
