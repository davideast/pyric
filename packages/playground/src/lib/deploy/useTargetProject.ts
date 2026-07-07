/**
 * The Firebase project the deploy hooks ship artifacts to.
 *
 * Stores `projectId` (required for every deploy primitive),
 * `siteId` (optional override; defaults to `projectId` since
 * Firebase auto-provisions a default Hosting site named after the
 * project), and `firebaseConfig` (the web SDK config injected into
 * the template's `src/generated/firebase-config.ts` slot at deploy
 * time so the deployed bundle talks to the right project).
 *
 * Persisted via the workspace store; re-deploys to the same
 * project don't re-prompt.
 */
import { useWorkspaceStore, type DeployTarget } from '~/lib/store/workspace';

export interface UseTargetProjectResult {
  /** Current target, or null if none configured yet. */
  target: DeployTarget | null;
  /** Whether enough config is present to drive the deploy hooks. */
  ready: boolean;
  /** Replace the entire target (persists to localStorage). */
  setTarget: (next: DeployTarget | null) => void;
  /**
   * Resolved site id — the explicit `siteId` if set, otherwise the
   * `projectId` (Firebase's auto-provisioned default site).
   * Returns `null` if no target is configured.
   */
  resolvedSiteId: string | null;
}

export function useTargetProject(): UseTargetProjectResult {
  const target = useWorkspaceStore((s) => s.deployTarget);
  const setTarget = useWorkspaceStore((s) => s.setDeployTarget);
  const resolvedSiteId = target ? (target.siteId ?? target.projectId) : null;
  // Minimum viable target for the deploy hooks: a non-empty
  // projectId. firebaseConfig is required for the Hosting build
  // (the template needs it to wire `initializeApp`); siteId is
  // optional. Hooks that need stricter readiness can layer
  // additional checks.
  const ready = target !== null && target.projectId.length > 0;
  return { target, ready, setTarget, resolvedSiteId };
}

export function readTargetProject(): DeployTarget | null {
  return useWorkspaceStore.getState().deployTarget;
}
