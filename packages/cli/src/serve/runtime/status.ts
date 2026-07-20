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
  errors: readonly PyricRuntimeError[];
}

export interface PyricRuntimeStatus {
  getSnapshot(): PyricRuntimeSnapshot;
  subscribe(listener: (snapshot: PyricRuntimeSnapshot) => void): () => void;
  setWorker(input: { mode: Exclude<PyricRuntimeMode, 'starting'>; runningEpoch?: string | null }): void;
  reportError(error: unknown, source: PyricRuntimeErrorSource): void;
  recordSandboxEvents(events: readonly SandboxEvent[]): void;
  clearErrors(): void;
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

function sandboxError(event: SandboxEvent): PyricRuntimeError | null {
  if (event.kind === 'runtime_error') {
    return {
      id: event.id,
      source: 'sandbox',
      at: event.at,
      service: event.service,
      method: event.method,
      ...(event.path ? { path: event.path } : {}),
      ...(event.error.code ? { code: event.error.code } : {}),
      message: event.error.message,
    };
  }
  if (event.kind === 'listener_errored' && event.error) {
    return {
      id: event.id,
      source: 'sandbox',
      at: event.at,
      service: 'firestore',
      method: 'listener',
      ...('path' in event.target ? { path: event.target.path } : {}),
      code: event.error.code,
      message: event.error.message,
    };
  }
  if (event.kind === 'listener' && event.phase === 'errored' && event.error) {
    return {
      id: event.id,
      source: 'sandbox',
      at: event.at,
      service: event.service,
      method: 'listener',
      ...(event.target.path ? { path: event.target.path } : {}),
      ...(event.error.code ? { code: event.error.code } : {}),
      message: event.error.message,
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
    errors: [],
  };

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
      });
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
