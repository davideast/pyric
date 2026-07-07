/**
 * Run the three pre-flight checks (`hosting-site`, `firestore-db`,
 * `iam-permissions`) against the configured target project and
 * access token. Thin React wrapper over `runPreflight` from
 * `@pyric/deploy` — the portable primitive does the three GETs in
 * parallel; this hook owns the React state.
 *
 * Used standalone (a "Check project" button could call this) and as
 * the first step of `useDeployAll`.
 *
 * Inputs come from the deploy foundation hooks:
 *   - `useTargetProject()` → `projectId` + `resolvedSiteId`
 *   - `useAccessToken()` → `resolveToken` (GIS-minted bearer token)
 *
 * The checks are read-only; running them never mutates the target
 * project. Each `PreflightCheckResult` carries an `ok` flag, a
 * human summary, an optional Console deeplink (when remediation is
 * possible), and a structured `error`. See
 * `packages/deploy/src/preflight.ts` for the result schema.
 */
import { useCallback, useState } from 'react';

import {
  runPreflight,
  type PreflightCheckResult,
  type PreflightOptions,
  type ProjectScope,
} from 'pyric-tools/deploy';

import { useAccessToken } from './useAccessToken';
import { useTargetProject } from './useTargetProject';

export interface PreflightState {
  status: 'idle' | 'checking' | 'ok' | 'failed' | 'error';
  results: PreflightCheckResult[];
  /** Set when the whole call rejected (not when individual checks failed). */
  error?: { code: string; message: string };
}

export interface UseDeployPreflightResult {
  state: PreflightState;
  /** Run the three checks. Returns the aggregate result for callers
   *  that want to chain (`useDeployAll` does this). */
  run: (options?: PreflightOptions) => Promise<{
    ok: boolean;
    results: PreflightCheckResult[];
  } | null>;
  /** Gated on target project + token being present. */
  canRun: boolean;
  /** Reset state to idle — used when the orchestrator starts fresh. */
  reset: () => void;
}

const IDLE_STATE: PreflightState = { status: 'idle', results: [] };

export function useDeployPreflight(): UseDeployPreflightResult {
  const { target, ready: targetReady, resolvedSiteId } = useTargetProject();
  const { signedIn, resolveToken } = useAccessToken();

  const [state, setState] = useState<PreflightState>(IDLE_STATE);

  const canRun = targetReady && signedIn;

  const run = useCallback(
    async (options: PreflightOptions = {}) => {
      if (!target || !target.projectId || !signedIn) {
        setState({
          status: 'error',
          results: [],
          error: {
            code: 'invalid-input',
            message: 'Target project and Google sign-in are required.',
          },
        });
        return null;
      }

      setState({ status: 'checking', results: [] });

      const scope: ProjectScope = {
        projectId: target.projectId,
        resolveToken,
      };

      try {
        // IAM's `testIamPermissions` endpoint isn't CORS-enabled, so
        // the browser can't call it. Default to the two CORS-safe
        // checks; callers can still opt into IAM via `options.checks`
        // when running this from a server-side proxy.
        const result = await runPreflight(scope, {
          siteId: resolvedSiteId ?? target.projectId,
          checks: ['hosting-site', 'firestore-db'],
          ...options,
        });
        setState({
          status: result.ok ? 'ok' : 'failed',
          results: result.results,
        });
        return result;
      } catch (e) {
        setState({
          status: 'error',
          results: [],
          error: {
            code: 'unknown',
            message: e instanceof Error ? e.message : String(e),
          },
        });
        return null;
      }
    },
    [target, signedIn, resolveToken, resolvedSiteId],
  );

  const reset = useCallback(() => setState(IDLE_STATE), []);

  return { state, run, canRun, reset };
}
