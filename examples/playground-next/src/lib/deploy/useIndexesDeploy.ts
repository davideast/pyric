/**
 * Ship the composite-index requirements inferred from the
 * workspace's `appSource` to the user's target project.
 *
 * Two-step flow:
 *   1. Static analyzer (`extractIndexes` from the SDK) walks
 *      `appSource` and returns a `firestore.indexes.json`-shaped
 *      config. Pure AST pass, no network.
 *   2. For each entry, call `firestore.indexes.create` from
 *      `@pyric/deploy`. The Admin API kicks off a long-running
 *      operation (LRO) per index; the returned operation `name` is
 *      the polling handle. Names persist via
 *      `./pendingIndexOps.writePendingOps` so a refresh doesn't lose
 *      them — the "indexes build-progress UI" track reads the same
 *      key.
 *
 * Inference recall is ~60–80% per the milestone audit; runtime
 * `FAILED_PRECONDITION` capture is the planned fallback for the
 * recall gap and is NOT in scope here.
 *
 * Other deploy tracks (Hosting, Rules) share the placeholder
 * section in `DeployTab` and follow the same `useXxxDeploy` shape.
 */
import { useCallback, useState } from 'react';

import {
  AdminApiError,
  firestore,
  type IndexesConfigEntry,
  type IndexOperation,
  type ProjectScope,
} from 'pyric-tools/deploy';

import { useAccessToken } from '~/lib/deploy/useAccessToken';
import { useTargetProject } from '~/lib/deploy/useTargetProject';
import { useWorkspaceStore } from '~/lib/store/workspace';

import { extractIndexesFromAppSource } from './extractIndexes';
import {
  writePendingOps,
  type IndexOperationStatus,
} from './pendingIndexOps';

// Re-exported so existing callers that imported the type from this
// module keep compiling. New code should import from `./pendingIndexOps`.
export type { IndexOperationStatus };

export interface IndexesDeployState {
  status: 'idle' | 'extracting' | 'creating' | 'success' | 'partial' | 'error';
  /** Operations the deploy started — used by the polling track. */
  operations: IndexOperationStatus[];
  error?: { code: string; message: string };
  /**
   * If the static analyzer surfaced no indexes from the current
   * appSource. Not an error — the app may genuinely not need any.
   */
  empty?: boolean;
}

export interface UseIndexesDeployResult {
  state: IndexesDeployState;
  deploy: () => Promise<void>;
  canDeploy: boolean;
}

export function useIndexesDeploy(): UseIndexesDeployResult {
  const { target, ready: targetReady } = useTargetProject();
  const { signedIn, resolveToken } = useAccessToken();
  const appSource = useWorkspaceStore((s) => s.appSource);

  const [state, setState] = useState<IndexesDeployState>({
    status: 'idle',
    operations: [],
  });

  const canDeploy = targetReady && signedIn && appSource.length > 0;

  const deploy = useCallback(async () => {
    if (!target || !target.projectId || !signedIn || appSource.length === 0) {
      setState({
        status: 'error',
        operations: [],
        error: {
          code: 'invalid-input',
          message: 'Target project, Google sign-in, and app source are all required.',
        },
      });
      return;
    }

    setState({ status: 'extracting', operations: [] });

    let entries: IndexesConfigEntry[];
    try {
      entries = await extractIndexesFromAppSource(appSource);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setState({
        status: 'error',
        operations: [],
        error: { code: 'extract-failed', message },
      });
      return;
    }

    if (entries.length === 0) {
      setState({ status: 'success', operations: [], empty: true });
      return;
    }

    setState({ status: 'creating', operations: [] });

    const scope: ProjectScope = {
      projectId: target.projectId,
      resolveToken,
    };

    const started: IndexOperationStatus[] = [];
    const failures: { entry: IndexesConfigEntry; error: { code: string; message: string } }[] = [];

    for (const entry of entries) {
      try {
        const op: IndexOperation = await firestore.indexes.create(scope, entry);
        started.push(toStatus(op.name, entry));
      } catch (e) {
        failures.push({ entry, error: classifyError(e) });
      }
    }

    writePendingOps(started);

    if (failures.length === 0) {
      setState({ status: 'success', operations: started });
      return;
    }

    if (started.length === 0) {
      setState({
        status: 'error',
        operations: [],
        error: failures[0]!.error,
      });
      return;
    }

    setState({
      status: 'partial',
      operations: started,
      error: {
        code: failures[0]!.error.code,
        message: `${failures.length} of ${entries.length} indexes failed to create: ${failures[0]!.error.message}`,
      },
    });
  }, [target, signedIn, resolveToken, appSource]);

  return { state, deploy, canDeploy };
}

function toStatus(operationName: string, entry: IndexesConfigEntry): IndexOperationStatus {
  return {
    operationName,
    state: 'CREATING',
    collectionGroup: entry.collectionGroup,
    fields: entry.fields.map((f) => ({
      fieldPath: f.fieldPath,
      ...(f.order ? { order: f.order } : {}),
      ...(f.arrayConfig ? { arrayConfig: f.arrayConfig } : {}),
    })),
  };
}

function classifyError(e: unknown): { code: string; message: string } {
  if (e instanceof AdminApiError) {
    if (e.status === 401 || e.status === 403) {
      return { code: 'permission-denied', message: e.message };
    }
    if (e.status === 404) {
      return { code: 'not-found', message: e.message };
    }
    if (e.status === 409) {
      return { code: 'already-exists', message: e.message };
    }
    return { code: `http-${e.status}`, message: e.message };
  }
  if (e instanceof Error) return { code: 'unknown', message: e.message };
  return { code: 'unknown', message: String(e) };
}
