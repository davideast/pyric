/**
 * Workspace store — what the user is editing. The agent reads this
 * via `systemPromptBuilder` so it sees the current state every turn.
 *
 * Fields:
 *   - `rules`, `code`, `appSource` — the three editor bodies. All
 *     start empty; zero-state UI directs the user to start writing
 *     or ask the agent.
 *   - `deployTarget` — the user's Firebase project the deploy hooks
 *     ship to: project id, optional named site, optional Firebase
 *     web config (injected into the template's
 *     `src/generated/firebase-config.ts` at deploy time). Persisted
 *     so re-deploys don't re-prompt.
 *
 * Note: access tokens for cross-project Google API calls are not
 * stored here. They live in the `lib/auth/gis-token` module-level
 * cache (memory only — never persisted), reissued silently from the
 * active Google session via GIS.
 */
import { create } from 'zustand';

const DEPLOY_TARGET_STORAGE_KEY = 'pyric:deployTarget';

// 2026-06-11 — backend-IR removal hygiene. The removed backend-IR
// feature persisted a crawl of the user's REAL Firebase project under
// `pyric:backendIR` and injected it into every system prompt. Existing
// browsers still carry that stale prod snapshot; actively delete it on
// boot. This purge line can itself be deleted after a few releases.
if (typeof window !== 'undefined') {
  try { window.localStorage.removeItem('pyric:backendIR'); } catch { /* ignore */ }
}

/**
 * The user-owned target the deploy hooks ship artifacts to. The
 * `firebaseConfig` slot is what gets written into the template's
 * `src/generated/firebase-config.ts` at deploy time so the deployed
 * app talks to the right project. `siteId` defaults to `projectId`
 * when omitted (Firebase auto-provisions a default Hosting site
 * named after the project).
 */
export interface DeployTarget {
  projectId: string;
  siteId?: string;
  firebaseConfig?: {
    apiKey: string;
    authDomain: string;
    projectId: string;
    storageBucket?: string;
    messagingSenderId?: string;
    appId?: string;
  };
}

interface WorkspaceState {
  rules: string;
  appSource: string;
  deployTarget: DeployTarget | null;
  setRules: (next: string) => void;
  setAppSource: (next: string) => void;
  setDeployTarget: (next: DeployTarget | null) => void;
}

function readPersistedDeployTarget(): DeployTarget | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(DEPLOY_TARGET_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as DeployTarget;
  } catch (e) {
    console.warn('[workspace] localStorage read failed for deployTarget:', e);
    return null;
  }
}

function writePersistedDeployTarget(target: DeployTarget | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (target) window.localStorage.setItem(DEPLOY_TARGET_STORAGE_KEY, JSON.stringify(target));
    else window.localStorage.removeItem(DEPLOY_TARGET_STORAGE_KEY);
  } catch (e) {
    console.warn('[workspace] localStorage write failed for deployTarget:', e);
  }
}

export const useWorkspaceStore = create<WorkspaceState>()((set) => ({
  rules: '',
  appSource: '',
  deployTarget: readPersistedDeployTarget(),
  setRules: (rules) => set({ rules }),
  setAppSource: (appSource) => set({ appSource }),
  setDeployTarget: (deployTarget) => {
    writePersistedDeployTarget(deployTarget);
    set({ deployTarget });
  },
}));

// ─── Test-only seed hatch ────────────────────────────────────────────
// E2E tests need to plant deterministic editor + target state without
// driving the agent or filling forms. Calling
// `window.__pyricTestSeed({ appSource, rules, deployTarget })` routes
// through the same setters the UI uses, so persistence + downstream
// effects (deploy hooks reading from the store) match a real session.
// Gated on `import.meta.env.DEV` so `astro build` tree-shakes the
// entire block out — the production bundle contains no reference to
// `__pyricTestSeed`.
export interface PyricTestSeed {
  rules?: string;
  appSource?: string;
  deployTarget?: DeployTarget | null;
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
    if (partial.appSource !== undefined) store.setAppSource(partial.appSource);
    if (partial.deployTarget !== undefined) store.setDeployTarget(partial.deployTarget);
  };
}
