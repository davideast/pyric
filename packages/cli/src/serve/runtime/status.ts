import type { HostedConnectionState } from '../worker/client/websocket-connection.js';
import type { SandboxEvent } from 'pyric/sandbox';
import type { PyricRuntimeManifest } from './manifest.js';
import { readPyricRuntimeManifest } from './manifest.js';
import { hostRestartWarning, type HostRestart } from './host-restart.js';
import type { SharedWorkerFallbackInfo } from './shared-worker-fallback.js';

type PyricRuntimeMode = 'starting' | 'shared-worker' | 'in-page' | 'hosted';
export type PyricRuntimeErrorSource = 'sandbox' | 'worker' | 'runtime';

export interface PyricRuntimeError {
  id: string;
  source: PyricRuntimeErrorSource;
  at: number;
  message: string;
  code?: string;
  stack?: string;
  service?: string;
  method?: string;
  path?: string;
}

interface PyricRuntimeSnapshot {
  manifest: PyricRuntimeManifest;
  mode: PyricRuntimeMode;
  servedEpoch: string | null;
  runningEpoch: string | null;
  updateAvailable: boolean;
  updatingWorker: boolean;
  errors: readonly PyricRuntimeError[];
  inPageFallback?: SharedWorkerFallbackInfo | null;
  hostedConnection?: HostedConnectionState;
  persistenceUnhealthy?: boolean;
  /** The host restarted since this page loaded, so the tab runs a stale bundle. */
  hostBundleStale?: boolean;
}

export interface PyricRuntimeStatus {
  getSnapshot(): PyricRuntimeSnapshot;
  subscribe(listener: (snapshot: PyricRuntimeSnapshot) => void): () => void;
  setWorker(input: {
    mode: Exclude<PyricRuntimeMode, 'starting'>;
    runningEpoch?: string | null;
    inPageFallback?: SharedWorkerFallbackInfo | null;
  }): void;
  setHostedConnection(state: HostedConnectionState): void;
  /** Marks the tab stale and warns in the console, once per page. */
  reportHostRestarted(restart: HostRestart): void;
  setWorkerUpdater(update: (() => Promise<void>) | null): void;
  updateWorker(): Promise<void>;
  reportError(error: unknown, source: PyricRuntimeErrorSource): void;
  recordSandboxEvents(events: readonly SandboxEvent[]): void;
  clearErrors(): void;
  dismissError(id: string): void;
}

let nextErrorId = 0;

function errorCode(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Convert thrown values into a serializable, copyable runtime error. */
export function normalizePyricRuntimeError(
  value: unknown,
  source: PyricRuntimeErrorSource,
  at = Date.now(),
  id = `runtime-error-${++nextErrorId}`,
): PyricRuntimeError {
  if (value instanceof Error) {
    const normalized: PyricRuntimeError = {
      id,
      source,
      at,
      message: value.message,
    };
    const code = errorCode(value);
    if (code) normalized.code = code;
    if (value.stack) normalized.stack = value.stack;
    return normalized;
  }
  if (typeof value === 'string') return { id, source, at, message: value };
  if (value && typeof value === 'object') {
    const message = (value as { message?: unknown }).message;
    const normalized: PyricRuntimeError = {
      id,
      source,
      at,
      message: typeof message === 'string' ? message : String(value),
    };
    const code = errorCode(value);
    if (code) normalized.code = code;
    return normalized;
  }
  return { id, source, at, message: String(value) };
}

function isOperationOrRequestEvent(event: SandboxEvent): boolean {
  const isOperationKind = event.kind === 'operation';
  const isRequestKind = event.kind === 'request';
  return isOperationKind || isRequestKind;
}

function isDeniedOperationEvent(event: SandboxEvent): boolean {
  const isTargetEventKind = isOperationOrRequestEvent(event);
  const hasResultProperty = 'result' in event;
  const isDeniedResult = hasResultProperty && event.result === 'deny';
  return isTargetEventKind && isDeniedResult;
}

function isRuntimeErrorEvent(event: SandboxEvent): boolean {
  return event.kind === 'runtime_error';
}

function isListenerErroredEvent(event: SandboxEvent): boolean {
  const isListenerErroredKind = event.kind === 'listener_errored';
  const hasErrorPayload = 'error' in event && Boolean(event.error);
  return isListenerErroredKind && hasErrorPayload;
}

function isCompanionRtdbDenialListenerEvent(event: SandboxEvent): boolean {
  const isRtdbListener = event.kind === 'listener' && event.service === 'rtdb';
  const isDeniedPhase = 'phase' in event && event.phase === 'errored' && 'result' in event && event.result === 'deny';
  return isRtdbListener && isDeniedPhase;
}

function isListenerPhaseErroredEvent(event: SandboxEvent): boolean {
  if (isCompanionRtdbDenialListenerEvent(event)) return false;
  const isListenerKind = event.kind === 'listener';
  const isErroredPhase = 'phase' in event && event.phase === 'errored';
  const hasErrorPayload = 'error' in event && Boolean(event.error);
  return isListenerKind && isErroredPhase && hasErrorPayload;
}

function isAiRejectedEvent(event: SandboxEvent): boolean {
  const isServiceMutationKind = event.kind === 'service_mutation';
  const isAiService = event.service === 'ai';
  const isRejectedOp = 'op' in event && event.op === 'request_rejected';
  return isServiceMutationKind && isAiService && isRejectedOp;
}

/** Observation delivery failures do not change the reported outcome of the operation. */
function observationGapError(event: SandboxEvent): PyricRuntimeError | null {
  const isObservationGap = event.kind === 'observation_gap';
  if (isObservationGap) {
    let message = 'Sandbox activity is incomplete because an observation batch exceeded the 12 MiB size limit.';
    if (event.reason === 'history-limit') {
      message = 'Older sandbox activity was evicted from the bounded observation history.';
    }
    return {
      id: event.id, source: 'worker', at: event.at,
      code: 'resource-exhausted', method: 'observation-delivery',
      message,
    };
  }
  return null;
}

function sandboxError(event: SandboxEvent): PyricRuntimeError | null {
  if (isRuntimeErrorEvent(event)) {
    const hasPathProperty = 'path' in event && typeof event.path === 'string';
    const targetPath = hasPathProperty ? event.path : undefined;
    const hasMethodProperty = 'method' in event && typeof event.method === 'string';
    const targetMethod = hasMethodProperty ? event.method : 'unknown';
    const hasErrorPayload = 'error' in event && Boolean(event.error);
    const errorPayload = hasErrorPayload ? (event as { error: { code?: string; message: string } }).error : undefined;
    const error: PyricRuntimeError = {
      id: event.id,
      source: 'sandbox',
      at: event.at,
      service: event.service,
      method: targetMethod,
      message: errorPayload?.message ? errorPayload.message : 'Sandbox runtime error',
    };
    if (targetPath) error.path = targetPath;
    if (errorPayload?.code) error.code = errorPayload.code;
    return error;
  }
  if (isAiRejectedEvent(event)) {
    const detail = 'detail' in event ? (event.detail as Record<string, unknown> | undefined) : undefined;
    const code = typeof detail?.code === 'string' ? detail.code : 'AI_ERROR';
    const message = typeof detail?.message === 'string' ? detail.message : 'AI request rejected';
    const hasPathProperty = 'path' in event && typeof event.path === 'string';
    const targetPath = hasPathProperty ? event.path : '(ai)';
    return {
      id: event.id,
      source: 'sandbox',
      at: event.at,
      service: 'ai',
      method: 'generateContent',
      path: targetPath,
      code,
      message: `AI_ERROR: ${message}`,
    };
  }
  if (isListenerErroredEvent(event)) {
    const errorPayload = (event as { error: { code?: string; message: string } }).error;
    const error: PyricRuntimeError = {
      id: event.id,
      source: 'sandbox',
      at: event.at,
      service: 'firestore',
      method: 'listener',
      message: errorPayload.message,
    };
    if ('target' in event && event.target && 'path' in event.target) {
      error.path = event.target.path;
    }
    if (errorPayload.code) error.code = errorPayload.code;
    return error;
  }
  if (isListenerPhaseErroredEvent(event)) {
    const errorPayload = (event as { error: { code?: string; message: string } }).error;
    const error: PyricRuntimeError = {
      id: event.id,
      source: 'sandbox',
      at: event.at,
      service: event.service,
      method: 'listener',
      message: errorPayload.message,
    };
    if ('target' in event && event.target && 'path' in event.target) {
      error.path = event.target.path;
    }
    if (errorPayload.code) error.code = errorPayload.code;
    return error;
  }
  if (isDeniedOperationEvent(event)) {
    const hasPathProperty = 'path' in event && typeof event.path === 'string';
    const targetPath = hasPathProperty ? event.path : '(service)';
    const hasMethodProperty = 'method' in event && typeof event.method === 'string';
    const targetMethod = hasMethodProperty ? event.method : 'operation';
    return {
      id: event.id,
      source: 'sandbox',
      at: event.at,
      service: event.service,
      method: targetMethod,
      path: targetPath,
      code: 'PERMISSION_DENIED',
      message: `PERMISSION_DENIED: ${targetMethod} on ${targetPath} denied by rules`,
    };
  }
  return null;
}

function sameFallback(
  left: SharedWorkerFallbackInfo | null | undefined,
  right: SharedWorkerFallbackInfo | null | undefined,
): boolean {
  const normalizedLeft = left ?? null;
  const normalizedRight = right ?? null;
  if (normalizedLeft === normalizedRight) return true;
  if (normalizedLeft === null || normalizedRight === null) return false;
  return (
    normalizedLeft.reason === normalizedRight.reason
    && normalizedLeft.tabSyncAvailable === normalizedRight.tabSyncAvailable
  );
}

/** Observable, bounded status model shared by the runtime and injected UI. */
export function createPyricRuntimeStatus(
  manifest: PyricRuntimeManifest,
  options: { maxErrors?: number } = {},
): PyricRuntimeStatus {
  const maxErrors = Math.max(1, options.maxErrors ?? 50);
  const listeners = new Set<(snapshot: PyricRuntimeSnapshot) => void>();
  const errorIds = new Set<string>();
  let snapshot: PyricRuntimeSnapshot = {
    manifest,
    mode: 'starting',
    servedEpoch: manifest.worker.servedEpoch,
    runningEpoch: null,
    updateAvailable: false,
    updatingWorker: false,
    errors: [],
    inPageFallback: null,
  };
  let workerUpdater: (() => Promise<void>) | null = null;

  const publish = (next: PyricRuntimeSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener(snapshot);
  };
  const appendError = (error: PyricRuntimeError): void => {
    const isDuplicate = errorIds.has(error.id);
    if (isDuplicate) return;
    errorIds.add(error.id);
    const errors = [...snapshot.errors, error].slice(-maxErrors);
    const retained = new Set(errors.map((item) => item.id));
    for (const id of errorIds) {
      const wasEvicted = !retained.has(id);
      if (wasEvicted) errorIds.delete(id);
    }
    const persistenceFailure = error.code === 'persistence-unhealthy' || error.code === 'committed-but-not-durable';
    const persistenceUnhealthy = snapshot.persistenceUnhealthy || persistenceFailure;
    publish({ ...snapshot, errors, persistenceUnhealthy });
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    setWorker({ mode, runningEpoch = null, inPageFallback }) {
      const servedEpoch = manifest.worker.servedEpoch;
      const updateAvailable = Boolean(
        mode === 'shared-worker'
        && servedEpoch
        && runningEpoch
        && runningEpoch !== 'dev'
        && servedEpoch !== runningEpoch,
      );
      let nextFallback: SharedWorkerFallbackInfo | null = null;
      if (mode === 'in-page') {
        const currentFallback = snapshot.inPageFallback ?? null;
        nextFallback = inPageFallback === undefined ? currentFallback : inPageFallback;
      }
      const isUnchanged = snapshot.mode === mode
        && snapshot.runningEpoch === runningEpoch
        && snapshot.updateAvailable === updateAvailable
        && snapshot.updatingWorker === false
        && sameFallback(snapshot.inPageFallback, nextFallback);
      if (isUnchanged) return;
      publish({
        ...snapshot,
        mode,
        runningEpoch,
        updateAvailable,
        updatingWorker: false,
        inPageFallback: nextFallback,
      });
    },
    setHostedConnection(hostedConnection) {
      if (snapshot.hostedConnection === hostedConnection) return;
      publish({ ...snapshot, hostedConnection });
    },
    reportHostRestarted(restart) {
      // The socket and the health poll can both see the restart; the page warns once.
      if (snapshot.hostBundleStale === true) return;
      console.warn(hostRestartWarning(restart));
      publish({ ...snapshot, hostBundleStale: true });
    },
    setWorkerUpdater(update) {
      workerUpdater = update;
    },
    async updateWorker() {
      const update = workerUpdater;
      const cannotUpdate = !snapshot.updateAvailable || snapshot.updatingWorker || update === null;
      if (cannotUpdate) {
        throw new Error('No Pyric worker update is available.');
      }
      publish({ ...snapshot, updatingWorker: true });
      try {
        await update();
      } catch (error) {
        publish({ ...snapshot, updatingWorker: false });
        appendError(normalizePyricRuntimeError(error, 'worker'));
        throw error;
      }
    },
    reportError(error, source) {
      appendError(normalizePyricRuntimeError(error, source));
    },
    recordSandboxEvents(events) {
      for (const event of events) {
        const normalized = observationGapError(event) ?? sandboxError(event);
        const hasError = normalized !== null;
        if (hasError) appendError(normalized);
      }
    },
    clearErrors() {
      const alreadyEmpty = snapshot.errors.length === 0 && errorIds.size === 0;
      if (alreadyEmpty) return;
      errorIds.clear();
      publish({ ...snapshot, errors: [] });
    },
    dismissError(id) {
      const isUnknownError = !errorIds.has(id);
      if (isUnknownError) return;
      errorIds.delete(id);
      publish({
        ...snapshot,
        errors: snapshot.errors.filter((err) => err.id !== id),
      });
    },
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __pyricRuntime: PyricRuntimeStatus | undefined;
}

/** One global status source even when the runtime and UI are separate bundles. */
export function getPyricRuntimeStatus(): PyricRuntimeStatus {
  return globalThis.__pyricRuntime
    ??= createPyricRuntimeStatus(readPyricRuntimeManifest());
}
