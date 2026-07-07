/**
 * Ship the workspace's Firestore rules editor body to the user's
 * target project. Thin React wrapper over
 * `firestore.rules.deploy` from `@pyric/deploy` — the portable
 * primitive does the create-ruleset + PATCH-release dance; this
 * hook owns React state and the `ProjectScope` shim.
 *
 * Note: `firestore.rules.deploy` returns `void`, so `rulesetId` is
 * not surfaced from the underlying call today. `createdAt` is
 * stamped client-side when the deploy resolves. Both fields are
 * optional on the state so the UI can render them when (later) the
 * primitive starts handing them back.
 *
 * Other deploy tracks (Hosting, Indexes) share the placeholder
 * section in `DeployTab` and follow the same `useXxxDeploy` shape.
 */
import { useCallback, useState } from 'react';

import { firestore, AdminApiError, type ProjectScope } from 'pyric-tools/deploy';

import { useAccessToken } from '~/lib/deploy/useAccessToken';
import { useTargetProject } from '~/lib/deploy/useTargetProject';
import { useWorkspaceStore } from '~/lib/store/workspace';

export interface RulesDeployState {
  status: 'idle' | 'deploying' | 'success' | 'error';
  rulesetId?: string;
  createdAt?: string;
  error?: { code: string; message: string };
}

export interface UseRulesDeployResult {
  state: RulesDeployState;
  deploy: () => Promise<void>;
  /** True when target is configured, a token is pasted, and the
   *  rules editor body is non-empty. */
  canDeploy: boolean;
}

export function useRulesDeploy(): UseRulesDeployResult {
  const { target, ready: targetReady } = useTargetProject();
  const { signedIn, resolveToken } = useAccessToken();
  const rules = useWorkspaceStore((s) => s.rules);

  const [state, setState] = useState<RulesDeployState>({ status: 'idle' });

  const canDeploy = targetReady && signedIn && rules.length > 0;

  const deploy = useCallback(async () => {
    if (!target || !target.projectId || !signedIn || rules.length === 0) {
      setState({
        status: 'error',
        error: {
          code: 'invalid-input',
          message: 'Target project, Google sign-in, and rules source are all required.',
        },
      });
      return;
    }

    setState({ status: 'deploying' });

    const scope: ProjectScope = {
      projectId: target.projectId,
      resolveToken,
    };

    try {
      await firestore.rules.deploy(scope, rules);
      setState({
        status: 'success',
        createdAt: new Date().toISOString(),
      });
    } catch (e) {
      setState({ status: 'error', error: classifyError(e) });
    }
  }, [target, signedIn, resolveToken, rules]);

  return { state, deploy, canDeploy };
}

function classifyError(e: unknown): { code: string; message: string } {
  if (e instanceof AdminApiError) {
    if (e.status === 401 || e.status === 403) {
      return { code: 'permission-denied', message: e.message };
    }
    if (e.status === 404) {
      return { code: 'not-found', message: e.message };
    }
    return { code: `http-${e.status}`, message: e.message };
  }
  if (e instanceof Error) return { code: 'unknown', message: e.message };
  return { code: 'unknown', message: String(e) };
}
