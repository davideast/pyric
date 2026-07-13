/**
 * Project-scope pointer — which real Firebase project the user is
 * working against. Read by the system-prompt builder and diagnostics
 * tools that inspect a real project.
 *
 * History: this store used to carry the legacy cloud-save machinery
 * (`saveState`, `currentSessionId`, per-email last-project pointers)
 * for `SessionsModal`. That modal — and the explicit save/load flow
 * against the user's Firebase Storage bucket — was superseded by the
 * local sessions store (`~/lib/sessions/`, ambient autosave; see
 * `~/lib/store/autosave.ts` for the visible status seam), so the
 * orphaned wiring was deleted with it.
 *
 * NOTE: nothing currently sets `currentProjectId`; project linking is
 * not yet exposed by the Playground UI.
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
