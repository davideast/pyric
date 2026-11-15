/**
 * Coordinates hosted session-capture flushing and rotation around destructive
 * clear operations (`sandbox.reset` with `scope: 'all'` and `sandbox.restore`).
 */
import type { OperationResult } from '../../bridge/surface/types.js';
import { formatCaptureEventCounts } from '../../verify/file-format.js';
import {
  createCaptureStore,
  PREVIOUS_CAPTURE_RELATIVE_PATH,
  summarizeCaptureJson,
} from '../capture-store.js';
import type { HostCtx } from '../worker/host-context.js';
import { resetHostSandbox } from '../worker/host/rules.js';

interface PreservedCaptureMetadata {
  path: string;
  eventCount: number;
  denialCount: number;
}

interface HostedCaptureClearOptions {
  ctx: HostCtx;
  projectDir: string;
  action: () => Promise<OperationResult>;
  syncRules?: () => void;
  afterFlush?: () => void;
}

interface HostedClearMethodOptions {
  key: 'sandbox.reset' | 'sandbox.restore';
  args: Record<string, unknown>;
  ctx: HostCtx;
  projectDir: string;
  call: () => Promise<OperationResult>;
  resetStorage: () => Promise<void>;
  syncRulesAfterRestore: () => void;
  reconcilePortSessions: () => void;
  restoreFirestoreSubscriptions: () => void;
}

function attachPreservedCapture(
  outcome: OperationResult,
  preserved: PreservedCaptureMetadata,
): OperationResult {
  const counts = formatCaptureEventCounts(preserved.eventCount, preserved.denialCount);
  const summary = `${outcome.summary} Previous session capture (${counts}) preserved at ${preserved.path}.`;
  let data: Record<string, unknown>;
  if (typeof outcome.data === 'object' && outcome.data !== null && !Array.isArray(outcome.data)) {
    data = { ...(outcome.data as Record<string, unknown>), previousCapture: preserved };
  } else {
    data = { previousCapture: preserved };
  }
  return { ...outcome, summary, data };
}

/**
 * Flush live events before clearing, run the clear operation, flush the empty
 * post-clear capture so `.pyric/last-session.json` rotates verbatim into
 * `.pyric/previous-session.json`, and attach preservation metadata only when
 * capture is active and disk preservation actually succeeded.
 */
async function withHostedCapturePreservation(
  options: HostedCaptureClearOptions,
): Promise<OperationResult> {
  const { ctx, projectDir, action, syncRules, afterFlush } = options;
  const flush = ctx.captureFlush;
  if (flush === undefined) {
    const outcome = await action();
    if (outcome.ok) {
      syncRules?.();
      afterFlush?.();
    }
    return outcome;
  }

  const store = createCaptureStore(projectDir);
  const hadLiveEvents = ctx.sandbox.history().length > 0;
  if (hadLiveEvents) {
    await flush();
  }
  const preFlushDisk = store.read();
  let preFlushSummary: { eventCount: number; denialCount: number } | null = null;
  if (preFlushDisk !== null) {
    preFlushSummary = summarizeCaptureJson(preFlushDisk);
  }

  const outcome = await action();
  if (!outcome.ok) return outcome;

  // Sync rule metadata (no events) before flushing the empty post-clear capture,
  // and verify rotation before re-attaching listeners (which emit listener_attach).
  syncRules?.();
  await flush();

  let result = outcome;
  if (preFlushDisk !== null && preFlushSummary !== null && preFlushSummary.eventCount > 0) {
    const postFlushDisk = store.read();
    if (postFlushDisk !== null) {
      const postFlushSummary = summarizeCaptureJson(postFlushDisk);
      if (postFlushSummary !== null && postFlushSummary.eventCount === 0) {
        const preservedDisk = store.readPrevious();
        if (preservedDisk === preFlushDisk) {
          result = attachPreservedCapture(outcome, {
            path: PREVIOUS_CAPTURE_RELATIVE_PATH,
            eventCount: preFlushSummary.eventCount,
            denialCount: preFlushSummary.denialCount,
          });
        }
      }
    }
  }

  afterFlush?.();
  return result;
}

/** Execute hosted `sandbox.reset` or `sandbox.restore` with capture preservation. */
export async function runHostedClearMethod(
  options: HostedClearMethodOptions,
): Promise<OperationResult> {
  const restoreListeners = () => {
    options.reconcilePortSessions();
    options.restoreFirestoreSubscriptions();
  };
  if (options.key === 'sandbox.restore') {
    return withHostedCapturePreservation({
      ctx: options.ctx,
      projectDir: options.projectDir,
      action: options.call,
      syncRules: options.syncRulesAfterRestore,
      afterFlush: restoreListeners,
    });
  }

  let scope = 'all';
  if (typeof options.args.scope === 'string') {
    scope = options.args.scope;
  }
  if (scope === 'all') {
    return withHostedCapturePreservation({
      ctx: options.ctx,
      projectDir: options.projectDir,
      action: () => resetHostSandbox(options.ctx, scope, options.call),
      afterFlush: restoreListeners,
    });
  }

  const outcome = await resetHostSandbox(options.ctx, scope, options.call);
  if (!outcome.ok) return outcome;
  if (scope === 'storage') {
    await options.resetStorage();
  } else if (scope === 'firestore') {
    options.restoreFirestoreSubscriptions();
  } else if (scope === 'auth') {
    options.reconcilePortSessions();
  }
  return outcome;
}
