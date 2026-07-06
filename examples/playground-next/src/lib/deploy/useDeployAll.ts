/**
 * Single-button orchestrator that ships the playground app to the
 * user's target Firebase project end-to-end. Wires the four phases:
 *
 *   1. Pre-flight  — three GETs (`hosting-site`, `firestore-db`,
 *      `iam-permissions`) via `runPreflight`. If any fail with a
 *      remediation surface (`not-found`, `service-not-enabled`), the
 *      orchestrator stops here — downstream calls would either 404
 *      or hit the same denied scope.
 *   2. Rules + Hosting — fired in parallel via `Promise.allSettled`.
 *      The two paths are independent (rules go to the Firestore
 *      Admin API; hosting goes to Hosting). Bundle for hosting
 *      happens inline before the upload step.
 *   3. Indexes — extract from `appSource` then create per-entry.
 *      LRO names persist to localStorage so the poll track can pick
 *      them up across refreshes. Indexes run regardless of whether
 *      rules/hosting failed (they're independent).
 *   4. Done — overall success is the conjunction of all three. On
 *      failure, the state retains per-step attribution so the UI can
 *      show which track to retry via the per-track buttons.
 *
 * No rollback. If hosting succeeds and rules fails, the live app
 * runs under the previous rules until the user re-deploys rules.
 * The orchestrator surfaces this; the UI nudges the user to retry
 * rules via the per-track button rather than re-running everything.
 */
import { useCallback, useState } from 'react';

import {
  AdminApiError,
  firestore,
  hosting,
  runPreflight,
  type IndexesConfigEntry,
  type IndexOperation,
  type PreflightCheckResult,
  type ProjectScope,
} from 'pyric-tools/deploy';

import { useWorkspaceStore } from '~/lib/store/workspace';

import { bundleAppToHostingFiles } from './bundleApp';
import { extractIndexesFromAppSource } from './extractIndexes';
import {
  writePendingOps,
  type IndexOperationStatus,
} from './pendingIndexOps';
import { useAccessToken } from './useAccessToken';
import { useTargetProject } from './useTargetProject';

// ─── State shapes ────────────────────────────────────────────────────

export type StepKind = 'preflight' | 'rules' | 'hosting' | 'indexes';

export type StepStatus<TData = unknown> =
  | { kind: 'pending' }
  | { kind: 'running' }
  | { kind: 'ok'; data: TData }
  | { kind: 'failed'; error: { code: string; message: string } }
  | { kind: 'skipped'; reason: string };

export interface PreflightStepData {
  results: PreflightCheckResult[];
}

export interface RulesStepData {
  createdAt: string;
}

export interface HostingStepData {
  hostingUrl: string;
  versionName?: string;
  releaseName?: string;
  fileCount: number;
  uploadedCount: number;
}

export interface IndexesStepData {
  operations: IndexOperationStatus[];
  /** Number of analyzed entries that failed to create (subset of operations). */
  failures: number;
  /** True when the analyzer surfaced no indexes — not an error. */
  empty: boolean;
}

export interface DeployAllState {
  phase: 'idle' | 'running' | 'success' | 'failed';
  preflight: StepStatus<PreflightStepData>;
  rules: StepStatus<RulesStepData>;
  hosting: StepStatus<HostingStepData>;
  indexes: StepStatus<IndexesStepData>;
}

export interface UseDeployAllResult {
  state: DeployAllState;
  deploy: () => Promise<void>;
  /** True when every input the orchestrator needs is present. */
  canDeploy: boolean;
  reset: () => void;
}

const IDLE_STATE: DeployAllState = {
  phase: 'idle',
  preflight: { kind: 'pending' },
  rules: { kind: 'pending' },
  hosting: { kind: 'pending' },
  indexes: { kind: 'pending' },
};

// ─── Hook ────────────────────────────────────────────────────────────

export function useDeployAll(): UseDeployAllResult {
  const { target, ready: targetReady, resolvedSiteId } = useTargetProject();
  const { signedIn, resolveToken } = useAccessToken();
  const appSource = useWorkspaceStore((s) => s.appSource);
  const rules = useWorkspaceStore((s) => s.rules);

  const [state, setState] = useState<DeployAllState>(IDLE_STATE);

  const canDeploy =
    targetReady && signedIn && appSource.length > 0 && resolvedSiteId !== null;

  const deploy = useCallback(async () => {
    if (!target || !resolvedSiteId || !signedIn || appSource.length === 0) {
      setState({
        ...IDLE_STATE,
        phase: 'failed',
        preflight: {
          kind: 'failed',
          error: {
            code: 'invalid-input',
            message:
              'Target project, Google sign-in, app source, and rules editor are all required.',
          },
        },
      });
      return;
    }

    const scope: ProjectScope = {
      projectId: target.projectId,
      resolveToken,
    };

    // Start fresh — preflight running, everything else pending.
    setState({
      phase: 'running',
      preflight: { kind: 'running' },
      rules: { kind: 'pending' },
      hosting: { kind: 'pending' },
      indexes: { kind: 'pending' },
    });

    // ── 1. Preflight ───────────────────────────────────────────────
    // IAM's `testIamPermissions` endpoint has no CORS headers; calls
    // from a browser fail with a CORS error before reaching the API.
    // Hosting + Firestore checks already return 403 if the caller
    // lacks the relevant scope, so the "wrong project / no permission"
    // case is covered. Skip IAM here; reintroduce only via a
    // server-side proxy if we need the explicit scope readout.
    let preflightResults: PreflightCheckResult[];
    try {
      const pre = await runPreflight(scope, {
        siteId: resolvedSiteId,
        checks: ['hosting-site', 'firestore-db'],
      });
      preflightResults = pre.results;
      if (!pre.ok) {
        const summary = pre.results
          .filter((r) => !r.ok)
          .map((r) => r.summary)
          .join(' · ');
        setState({
          phase: 'failed',
          preflight: {
            kind: 'failed',
            error: { code: 'preflight-failed', message: summary },
          },
          rules: { kind: 'skipped', reason: 'preflight failed' },
          hosting: { kind: 'skipped', reason: 'preflight failed' },
          indexes: { kind: 'skipped', reason: 'preflight failed' },
        });
        return;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setState({
        phase: 'failed',
        preflight: {
          kind: 'failed',
          error: { code: 'preflight-threw', message },
        },
        rules: { kind: 'skipped', reason: 'preflight threw' },
        hosting: { kind: 'skipped', reason: 'preflight threw' },
        indexes: { kind: 'skipped', reason: 'preflight threw' },
      });
      return;
    }

    // Preflight passed. Mark rules/hosting running and indexes
    // pending. Indexes wait until rules+hosting settle (cheaper to
    // serialize than worry about API quotas all firing at once).
    setState((prev) => ({
      ...prev,
      preflight: { kind: 'ok', data: { results: preflightResults } },
      rules: { kind: 'running' },
      hosting: { kind: 'running' },
    }));

    // ── 2. Rules + Hosting (parallel) ──────────────────────────────
    const rulesPromise = (async (): Promise<StepStatus<RulesStepData>> => {
      if (rules.length === 0) {
        return {
          kind: 'skipped',
          reason: 'rules editor is empty',
        };
      }
      try {
        await firestore.rules.deploy(scope, rules);
        return {
          kind: 'ok',
          data: { createdAt: new Date().toISOString() },
        };
      } catch (e) {
        return { kind: 'failed', error: classifyAdminError(e) };
      }
    })();

    const hostingPromise = (async (): Promise<StepStatus<HostingStepData>> => {
      try {
        const files = await bundleAppToHostingFiles({
          appSource,
          firebaseConfig: target.firebaseConfig,
          projectId: target.projectId,
        });
        const result = await hosting.deployFiles(scope, {
          siteId: resolvedSiteId,
          files,
        });
        if (result.success) {
          return {
            kind: 'ok',
            data: {
              hostingUrl: result.data.hostingUrl,
              versionName: result.data.versionName,
              releaseName: result.data.releaseName,
              fileCount: result.data.fileCount ?? files.length,
              uploadedCount: result.data.uploadedCount ?? 0,
            },
          };
        }
        return {
          kind: 'failed',
          error: { code: result.error.code, message: result.error.message },
        };
      } catch (e) {
        return {
          kind: 'failed',
          error: {
            code: 'hosting-threw',
            message: e instanceof Error ? e.message : String(e),
          },
        };
      }
    })();

    const [rulesStatus, hostingStatus] = await Promise.all([
      rulesPromise,
      hostingPromise,
    ]);

    setState((prev) => ({
      ...prev,
      rules: rulesStatus,
      hosting: hostingStatus,
      indexes: { kind: 'running' },
    }));

    // ── 3. Indexes ─────────────────────────────────────────────────
    const indexesStatus: StepStatus<IndexesStepData> = await runIndexes({
      scope,
      appSource,
    });

    // ── 4. Aggregate ───────────────────────────────────────────────
    const allOk =
      rulesStatus.kind !== 'failed' &&
      hostingStatus.kind !== 'failed' &&
      indexesStatus.kind !== 'failed';

    setState({
      phase: allOk ? 'success' : 'failed',
      preflight: { kind: 'ok', data: { results: preflightResults } },
      rules: rulesStatus,
      hosting: hostingStatus,
      indexes: indexesStatus,
    });
  }, [target, resolvedSiteId, signedIn, resolveToken, appSource, rules]);

  const reset = useCallback(() => setState(IDLE_STATE), []);

  return { state, deploy, canDeploy, reset };
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function runIndexes(args: {
  scope: ProjectScope;
  appSource: string;
}): Promise<StepStatus<IndexesStepData>> {
  let entries: IndexesConfigEntry[];
  try {
    entries = await extractIndexesFromAppSource(args.appSource);
  } catch (e) {
    return {
      kind: 'failed',
      error: {
        code: 'extract-failed',
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }

  if (entries.length === 0) {
    return {
      kind: 'ok',
      data: { operations: [], failures: 0, empty: true },
    };
  }

  const started: IndexOperationStatus[] = [];
  const failures: { entry: IndexesConfigEntry; error: { code: string; message: string } }[] = [];

  for (const entry of entries) {
    try {
      const op: IndexOperation = await firestore.indexes.create(args.scope, entry);
      started.push({
        operationName: op.name,
        state: 'CREATING',
        collectionGroup: entry.collectionGroup,
        fields: entry.fields.map((f) => ({
          fieldPath: f.fieldPath,
          ...(f.order ? { order: f.order } : {}),
          ...(f.arrayConfig ? { arrayConfig: f.arrayConfig } : {}),
        })),
      });
    } catch (e) {
      // 409 = the equivalent index already exists on the project from
      // a prior deploy. Idempotent re-deploys are part of the
      // milestone (user re-ships after edits; schema usually
      // unchanged). Treat as a no-op — there's no LRO to poll and the
      // existing index continues to back queries.
      if (e instanceof AdminApiError && e.status === 409) continue;
      failures.push({ entry, error: classifyAdminError(e) });
    }
  }

  writePendingOps(started);

  if (failures.length === 0) {
    return {
      kind: 'ok',
      data: { operations: started, failures: 0, empty: false },
    };
  }

  if (started.length === 0) {
    return { kind: 'failed', error: failures[0]!.error };
  }

  // Partial: surface as ok with `failures > 0` so the orchestrator
  // can still report overall success/failure separately. The state
  // shape on `kind: 'ok'` carries the failure count for the UI.
  return {
    kind: 'failed',
    error: {
      code: failures[0]!.error.code,
      message: `${failures.length} of ${entries.length} indexes failed: ${failures[0]!.error.message}`,
    },
  };
}

function classifyAdminError(e: unknown): { code: string; message: string } {
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
