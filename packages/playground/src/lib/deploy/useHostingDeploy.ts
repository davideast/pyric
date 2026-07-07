/**
 * Hosting deploy from the browser. Bundles `appSource` (from the
 * workspace store) into a two-file static artifact (`index.html` +
 * `assets/main-<hash>.js`), then ships it via `hosting.deployFiles`
 * from `@pyric/deploy`.
 *
 * Inputs come from the deploy foundation hooks:
 *   - `useTargetProject()` → siteId + `firebaseConfig` (injected into
 *      the bundled entry so the deployed app talks to the user's
 *      project)
 *   - `useAccessToken()` → GIS-minted bearer token (silently
 *      reissued from the active Google session)
 *   - `useWorkspaceStore` → `appSource` (the TSX the agent generated)
 *
 * Bundling logic lives in `./bundleApp` so `useDeployAll` can share
 * the same path. See that file for the synthetic-entry + esbuild-wasm
 * strategy and the metafile gate (refuses to ship a bundle with any
 * `@pyric/*` module). The gate throws `PyricLeakError`; this hook
 * surfaces it as an error state — no upload happens.
 *
 * Browser-only. No `node:*` imports.
 */

import { useCallback, useState } from 'react';

// `hosting.deployFiles(scope, options)` is the public, browser-
// portable wrapper around `deployHostingFiles` — same code path,
// but takes a `ProjectScope` (`projectId` + `resolveToken()`) so
// callers don't have to wire token resolution themselves. Resolves
// through `@pyric/deploy`'s barrel; no path alias needed.
import { hosting, type ProjectScope } from 'pyric-tools/deploy';
import type {
  DeployHostingResult,
  HostingErrorCode,
} from 'pyric-tools/deploy';

import { useWorkspaceStore } from '~/lib/store/workspace';

import { bundleAppToHostingFiles } from './bundleApp';
import { useAccessToken } from './useAccessToken';
import { useTargetProject } from './useTargetProject';

export interface HostingDeployState {
  status: 'idle' | 'bundling' | 'uploading' | 'success' | 'error';
  hostingUrl?: string;
  versionName?: string;
  releaseName?: string;
  fileCount?: number;
  uploadedCount?: number;
  error?: { code: string; message: string; recoverable: boolean };
}

export interface UseHostingDeployResult {
  state: HostingDeployState;
  deploy: () => Promise<void>;
  /** Gated on target + token + appSource being present. */
  canDeploy: boolean;
}

const IDLE_STATE: HostingDeployState = { status: 'idle' };

export function useHostingDeploy(): UseHostingDeployResult {
  const { target, ready: targetReady, resolvedSiteId } = useTargetProject();
  const { signedIn, resolveToken } = useAccessToken();
  const appSource = useWorkspaceStore((s) => s.appSource);

  const [state, setState] = useState<HostingDeployState>(IDLE_STATE);

  const canDeploy =
    targetReady && signedIn && appSource.length > 0 && resolvedSiteId !== null;

  const deploy = useCallback(async () => {
    // Re-check inside the callback — `canDeploy` is a render-time
    // value; the user could clear the token between mount and click.
    if (!target || !resolvedSiteId) {
      setState({
        status: 'error',
        error: {
          code: 'INVALID_INPUT',
          message: 'No deploy target configured. Set Project ID in the Deploy tab.',
          recoverable: true,
        },
      });
      return;
    }
    if (!signedIn) {
      setState({
        status: 'error',
        error: {
          code: 'INVALID_INPUT',
          message: 'Not signed in. Click "Sign in with Google" in the Deploy tab.',
          recoverable: true,
        },
      });
      return;
    }
    if (appSource.length === 0) {
      setState({
        status: 'error',
        error: {
          code: 'INVALID_INPUT',
          message: 'No app source to deploy. Write app code in the App editor.',
          recoverable: true,
        },
      });
      return;
    }

    setState({ status: 'bundling' });

    let files: { path: string; bytes: Uint8Array }[];
    try {
      files = await bundleAppToHostingFiles({
        appSource,
        firebaseConfig: target.firebaseConfig,
        projectId: target.projectId,
      });
    } catch (e) {
      setState({
        status: 'error',
        error: {
          code: 'INVALID_INPUT',
          message: `Bundle failed: ${e instanceof Error ? e.message : String(e)}`,
          recoverable: true,
        },
      });
      return;
    }

    setState({ status: 'uploading', fileCount: files.length });

    let result: DeployHostingResult;
    try {
      const scope: ProjectScope = {
        projectId: target.projectId,
        resolveToken,
      };
      result = await hosting.deployFiles(scope, {
        siteId: resolvedSiteId,
        files,
      });
    } catch (e) {
      // The core catches network errors internally and returns an
      // outcome, but a thrown error here is still possible (e.g.
      // crypto.subtle missing, CompressionStream absent). Surface
      // it so the UI doesn't get stuck on "uploading".
      setState({
        status: 'error',
        error: {
          code: 'NETWORK_ERROR',
          message: `Deploy threw: ${e instanceof Error ? e.message : String(e)}`,
          recoverable: true,
        },
      });
      return;
    }

    if (result.success) {
      setState({
        status: 'success',
        hostingUrl: result.data.hostingUrl,
        versionName: result.data.versionName,
        releaseName: result.data.releaseName,
        fileCount: result.data.fileCount,
        uploadedCount: result.data.uploadedCount,
      });
    } else {
      // `result.error.code` is the `HostingErrorCode` union — narrows
      // to a string for the state shape (`HostingDeployState.error.code`
      // is `string` so future error codes don't force a type update
      // in callers).
      const code: HostingErrorCode = result.error.code;
      setState({
        status: 'error',
        error: {
          code,
          message: result.error.message,
          recoverable: result.error.recoverable,
        },
      });
    }
  }, [target, resolvedSiteId, signedIn, resolveToken, appSource]);

  return { state, deploy, canDeploy };
}
