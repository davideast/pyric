/**
 * Workspace store — what the user is editing. The agent reads this
 * via `systemPromptBuilder` so it sees the current state every turn.
 *
 * Fields:
 *   - `rules`, `code`, `appSource` — the three editor bodies. All
 *     start empty; zero-state UI directs the user to start writing
 *     or ask the agent.
 */
import { create } from 'zustand';

// 2026-06-11 — backend-IR removal hygiene. The removed backend-IR
// feature persisted a crawl of the user's REAL Firebase project under
// `pyric:backendIR` and injected it into every system prompt. Existing
// browsers still carry that stale prod snapshot; actively delete it on
// boot. This purge line can itself be deleted after a few releases.
if (typeof window !== 'undefined') {
  try { window.localStorage.removeItem('pyric:backendIR'); } catch { /* ignore */ }
}

interface WorkspaceState {
  rules: string;
  databaseRules: string;
  appSource: string;
  setRules: (next: string) => void;
  setDatabaseRules: (next: string) => void;
  setAppSource: (next: string) => void;
}

export const useWorkspaceStore = create<WorkspaceState>()((set) => ({
  rules: '',
  databaseRules: '',
  appSource: '',
  setRules: (rules) => set({ rules }),
  setDatabaseRules: (databaseRules) => set({ databaseRules }),
  setAppSource: (appSource) => set({ appSource }),
}));

// ─── Test-only seed hatch ────────────────────────────────────────────
// E2E tests need to plant deterministic editor state without
// driving the agent or filling forms. Calling
// `window.__pyricTestSeed({ appSource, rules })` routes
// through the same setters the UI uses, so persistence + downstream
// effects match a real session.
// Gated on `import.meta.env.DEV` so `astro build` tree-shakes the
// entire block out — the production bundle contains no reference to
// `__pyricTestSeed`.
export interface PyricTestSeed {
  rules?: string;
  databaseRules?: string;
  appSource?: string;
}
declare global {
  interface Window {
    __pyricTestSeed?: (partial: PyricTestSeed) => void;
  }
}
if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__pyricTestSeed = (partial) => {
    const store = useWorkspaceStore.getState();
    if (partial.rules !== undefined) store.setRules(partial.rules);
    if (partial.databaseRules !== undefined) store.setDatabaseRules(partial.databaseRules);
    if (partial.appSource !== undefined) store.setAppSource(partial.appSource);
  };
}
