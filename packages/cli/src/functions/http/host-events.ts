/**
 * Emits served `onRequest` execution records onto the Node host's sandbox
 * event stream (`service: 'functions'`, `op: 'execution_finished'`) so Pyric
 * Studio and `functions.executions` observe HTTP runs alongside trigger runs,
 * while browser mode remains log-line-only (functions-http#21, #1768).
 */
import { getClock, type LocalSandbox, type Sandbox } from 'pyric/sandbox';
import type { CheckpointBackend } from 'pyric/sandbox/checkpoints';
import { emitSandboxEvent, makeServiceMutationEvent } from 'pyric/sandbox/internal';
import type { FunctionsHttpRecord } from './gateway.js';

const BIND_HOSTED_SANDBOX_SYMBOL = Symbol.for('pyric.hosted.bindSandbox');

interface HostedSandboxCapture {
  get(): LocalSandbox | null;
  clear(): void;
}

/**
 * Observe the `LocalSandbox` bound during `startHostedSandbox` through the
 * checkpoint backend's existing `pyric.hosted.bindSandbox` hook, preserving
 * any prior binder registered by `openHostedDatabase`.
 */
export function captureHostedSandbox(
  checkpoints: CheckpointBackend | undefined,
): HostedSandboxCapture {
  let bound: LocalSandbox | null = null;
  if (checkpoints !== undefined) {
    const carrier = checkpoints as unknown as Record<symbol, ((sb: Sandbox) => void) | undefined>;
    const prior = carrier[BIND_HOSTED_SANDBOX_SYMBOL];
    Object.defineProperty(checkpoints, BIND_HOSTED_SANDBOX_SYMBOL, {
      value: (sandbox: Sandbox): void => {
        if (typeof prior === 'function') {
          prior(sandbox);
        }
        bound = sandbox as LocalSandbox;
      },
      enumerable: false,
      configurable: true,
    });
  }
  return {
    get(): LocalSandbox | null {
      return bound;
    },
    clear(): void {
      bound = null;
    },
  };
}

/** Strip query string and fragment so tokens in query parameters never enter the event stream. */
function requestPathOnly(rawPath: string): string {
  const withoutQuery = rawPath.split(/[?#]/, 1)[0];
  if (withoutQuery !== undefined && withoutQuery.length > 0) {
    return withoutQuery;
  }
  return '/';
}

/**
 * Emit one finished `onRequest` run onto `sandbox`. Best-effort observational
 * emission: a throw from the sandbox handle never fails the served HTTP call.
 */
export function emitHttpExecutionEvent(
  sandbox: LocalSandbox,
  record: FunctionsHttpRecord,
  startedAt?: number,
): void {
  if (record.kind === 'callable') return;
  const pathOnly = requestPathOnly(record.path);
  try {
    const now = getClock(sandbox).now();
    let effectiveStartedAt = Math.max(0, now - record.durationMs);
    if (startedAt !== undefined) {
      effectiveStartedAt = startedAt;
    }
    let statusLabel = 'no response';
    if (record.status !== null) {
      statusLabel = String(record.status);
    }
    let executionStatus: 'fulfilled' | 'rejected' | 'timeout' = 'fulfilled';
    if (record.timedOut) {
      executionStatus = 'timeout';
    } else if (record.status === null || record.status >= 500) {
      executionStatus = 'rejected';
    }
    const params: Record<string, string> = {
      method: record.method,
      path: pathOnly,
      status: statusLabel,
    };
    const detail: Record<string, unknown> = {
      trigger: record.exportName,
      function: record.exportName,
      method: record.method,
      path: pathOnly,
      httpStatus: record.status,
      params,
      startedAt: effectiveStartedAt,
      durationMs: record.durationMs,
      status: executionStatus,
    };
    if (executionStatus === 'fulfilled') {
      detail.result = {
        method: record.method,
        path: pathOnly,
        status: record.status,
      };
    } else if (executionStatus === 'rejected') {
      if (record.status === null) {
        detail.error = `${record.method} ${pathOnly} ended without a response`;
      } else {
        detail.error = `${record.method} ${pathOnly} responded ${record.status}`;
      }
    }
    const event = makeServiceMutationEvent({
      at: now,
      service: 'functions',
      op: 'execution_finished',
      path: pathOnly,
      auth: null,
      detail,
    });
    emitSandboxEvent(sandbox, event, { service: 'functions' });
  } catch {
    // Observational: never let event emission break a served HTTP request.
  }
}
