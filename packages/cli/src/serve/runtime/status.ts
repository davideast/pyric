import type { SandboxEvent } from 'pyric/sandbox';
import type { PyricRuntimeManifest } from './manifest.js';
import { readPyricRuntimeManifest } from './manifest.js';

export type PyricRuntimeMode = 'starting' | 'shared-worker' | 'in-page';
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

export interface PyricRuntimeSnapshot {
  manifest: PyricRuntimeManifest;
  mode: PyricRuntimeMode;
  servedEpoch: string | null;
  runningEpoch: string | null;
  updateAvailable: boolean;
  updatingWorker: boolean;
  errors: readonly PyricRuntimeError[];
}

export interface PyricRuntimeStatus {
  getSnapshot(): PyricRuntimeSnapshot;
  subscribe(listener: (snapshot: PyricRuntimeSnapshot) => void): () => void;
  setWorker(input: { mode: Exclude<PyricRuntimeMode, 'starting'>; runningEpoch?: string | null }): void;
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
    return {
      id,
      source,
      at,
      message: value.message,
      ...(errorCode(value) ? { code: errorCode(value) } : {}),
      ...(value.stack ? { stack: value.stack } : {}),
    };
  }
  if (typeof value === 'string') return { id, source, at, message: value };
  if (value && typeof value === 'object') {
    const message = (value as { message?: unknown }).message;
    return {
      id,
      source,
      at,
      message: typeof message === 'string' ? message : String(value),
      ...(errorCode(value) ? { code: errorCode(value) } : {}),
    };
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

function isListenerPhaseErroredEvent(event: SandboxEvent): boolean {
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

function sandboxError(event: SandboxEvent): PyricRuntimeError | null {
  if (isRuntimeErrorEvent(event)) {
    const hasPathProperty = 'path' in event && typeof event.path === 'string';
    const targetPath = hasPathProperty ? event.path : undefined;
    const hasMethodProperty = 'method' in event && typeof event.method === 'string';
    const targetMethod = hasMethodProperty ? event.method : 'unknown';
    const hasErrorPayload = 'error' in event && Boolean(event.error);
    const errorPayload = hasErrorPayload ? (event as { error: { code?: string; message: string } }).error : undefined;
    return {
      id: event.id,
      source: 'sandbox',
      at: event.at,
      service: event.service,
      method: targetMethod,
      ...(targetPath ? { path: targetPath } : {}),
      ...(errorPayload?.code ? { code: errorPayload.code } : {}),
      message: errorPayload?.message ? errorPayload.message : 'Sandbox runtime error',
    };
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
    return {
      id: event.id,
      source: 'sandbox',
      at: event.at,
      service: 'firestore',
      method: 'listener',
      ...('target' in event && event.target && 'path' in event.target ? { path: event.target.path } : {}),
      code: errorPayload.code,
      message: errorPayload.message,
    };
  }
  if (isListenerPhaseErroredEvent(event)) {
    const errorPayload = (event as { error: { code?: string; message: string } }).error;
    return {
      id: event.id,
      source: 'sandbox',
      at: event.at,
      service: event.service,
      method: 'listener',
      ...('target' in event && event.target && 'path' in event.target ? { path: event.target.path } : {}),
      ...(errorPayload.code ? { code: errorPayload.code } : {}),
      message: errorPayload.message,
    };
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
  };
  let workerUpdater: (() => Promise<void>) | null = null;

  const publish = (next: PyricRuntimeSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener(snapshot);
  };
  const appendError = (error: PyricRuntimeError): void => {
    if (errorIds.has(error.id)) return;
    errorIds.add(error.id);
    const errors = [...snapshot.errors, error].slice(-maxErrors);
    const retained = new Set(errors.map((item) => item.id));
    for (const id of errorIds) if (!retained.has(id)) errorIds.delete(id);
    publish({ ...snapshot, errors });
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    setWorker({ mode, runningEpoch = null }) {
      const servedEpoch = manifest.worker.servedEpoch;
      publish({
        ...snapshot,
        mode,
        runningEpoch,
        updateAvailable: Boolean(
          mode === 'shared-worker'
          && servedEpoch
          && runningEpoch
          && runningEpoch !== 'dev'
          && servedEpoch !== runningEpoch,
        ),
        updatingWorker: false,
      });
    },
    setWorkerUpdater(update) {
      workerUpdater = update;
    },
    async updateWorker() {
      if (!snapshot.updateAvailable || snapshot.updatingWorker || !workerUpdater) {
        throw new Error('No Pyric worker update is available.');
      }
      publish({ ...snapshot, updatingWorker: true });
      try {
        await workerUpdater();
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
        const normalized = sandboxError(event);
        if (normalized) appendError(normalized);
      }
    },
    clearErrors() {
      errorIds.clear();
      publish({ ...snapshot, errors: [] });
    },
    dismissError(id) {
      if (!errorIds.has(id)) return;
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
