import type { ChildProcess } from 'node:child_process';
import {
  spawnFunctionsRtdbChild,
  type FunctionsRtdbChildEvent,
  type FunctionsRtdbChildHandle,
  type FunctionsRtdbChildReady,
  type SpawnFunctionsRtdbChildOptions,
} from './child.js';
import { buildChildEnv, createLinePrefixer } from '../cli/dev-runner.js';

const INITIAL_PEER_TIMEOUT_MS = 30_000;
const RELOAD_PEER_TIMEOUT_MS = 5_000;
const PEER_POLL_INTERVAL_MS = 250;

export interface FunctionsPeerReadiness {
  wait(options: { timeoutMs: number; signal: AbortSignal }): Promise<boolean>;
}

export type FunctionsDevelopmentResult =
  | { kind: 'ready'; ready: FunctionsRtdbChildReady }
  | { kind: 'no-peer' }
  | { kind: 'failed'; error: Error };

export type FunctionsDevelopmentEvent =
  | { type: 'child-event'; event: FunctionsRtdbChildEvent }
  | { type: 'output'; stream: 'stdout' | 'stderr'; line: string }
  | { type: 'unexpected-exit'; code: number };

export interface FunctionsDevelopmentRuntime {
  start(): Promise<FunctionsDevelopmentResult>;
  reload(): Promise<FunctionsDevelopmentResult>;
  close(): Promise<void>;
}

export interface FunctionsDevelopmentRuntimeOptions {
  sourceDir: string;
  entry: string;
  baseEnv: NodeJS.ProcessEnv;
  serveUrl: string;
  registerUrl: string;
  instance: string;
  location: string;
  projectId?: string;
  childModuleUrl?: string | URL;
  readiness: FunctionsPeerReadiness;
  onEvent?(event: FunctionsDevelopmentEvent): void;
  /** Internal test seam; production adapters use the real isolated child. */
  spawn?(options: SpawnFunctionsRtdbChildOptions): FunctionsRtdbChildHandle;
  initialPeerTimeoutMs?: number;
  reloadPeerTimeoutMs?: number;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function settleBeforeAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

export function createInProcessFunctionsPeerReadiness(
  connected: () => boolean,
  options: { intervalMs?: number; now?: () => number; sleep?: typeof abortableDelay } = {},
): FunctionsPeerReadiness {
  const intervalMs = options.intervalMs ?? PEER_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableDelay;
  return {
    async wait({ timeoutMs, signal }) {
      const deadline = now() + timeoutMs;
      while (!signal.aborted) {
        if (connected()) return true;
        if (now() >= deadline) return false;
        await sleep(intervalMs, signal);
      }
      return false;
    },
  };
}

export function createHttpFunctionsPeerReadiness(
  serveUrl: string,
  options: {
    intervalMs?: number;
    fetchImpl?: typeof fetch;
    now?: () => number;
    sleep?: typeof abortableDelay;
  } = {},
): FunctionsPeerReadiness {
  const baseUrl = serveUrl.replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const intervalMs = options.intervalMs ?? PEER_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableDelay;
  return {
    async wait({ timeoutMs, signal }) {
      const deadline = now() + timeoutMs;
      const deadlineAbort = new AbortController();
      const deadlineTimer = setTimeout(() => deadlineAbort.abort(), timeoutMs);
      deadlineTimer.unref();
      const waitSignal = AbortSignal.any([signal, deadlineAbort.signal]);
      try {
        while (!waitSignal.aborted) {
          try {
            const response = await settleBeforeAbort(
              fetchImpl(`${baseUrl}/__pyric/health`, { signal: waitSignal }),
              waitSignal,
            );
            if (response.ok) {
              const health = await settleBeforeAbort(
                response.json() as Promise<{ sandboxConnected?: boolean }>,
                waitSignal,
              );
              if (health.sandboxConnected === true) return true;
            }
          } catch {
            if (waitSignal.aborted) return false;
          }
          if (now() >= deadline) return false;
          await sleep(intervalMs, waitSignal);
        }
        return false;
      } finally {
        clearTimeout(deadlineTimer);
      }
    },
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function attachOutput(
  child: ChildProcess,
  emit: (event: FunctionsDevelopmentEvent) => void,
): void {
  const attach = (stream: 'stdout' | 'stderr'): void => {
    const readable = child[stream];
    if (!readable) return;
    const lines = createLinePrefixer('[functions] ', (line) => emit({ type: 'output', stream, line }));
    readable.setEncoding('utf8');
    readable.on('data', (chunk: string) => lines.push(chunk));
    readable.once('end', () => lines.flush());
  };
  attach('stdout');
  attach('stderr');
}

export function createFunctionsDevelopmentRuntime(
  options: FunctionsDevelopmentRuntimeOptions,
): FunctionsDevelopmentRuntime {
  const spawn = options.spawn ?? spawnFunctionsRtdbChild;
  const emit = (event: FunctionsDevelopmentEvent): void => options.onEvent?.(event);
  const expectedStops = new WeakSet<FunctionsRtdbChildHandle>();
  let activeChild: FunctionsRtdbChildHandle | null = null;
  let activeWait: AbortController | null = null;
  let closed = false;
  let startPromise: Promise<FunctionsDevelopmentResult> | null = null;
  let reloadPromise: Promise<FunctionsDevelopmentResult> | null = null;
  let reloadQueued = false;
  let closePromise: Promise<void> | null = null;

  const stopChild = async (child: FunctionsRtdbChildHandle | null): Promise<void> => {
    if (!child) return;
    expectedStops.add(child);
    if (activeChild === child) activeChild = null;
    await child.stop().catch(() => undefined);
  };

  const launch = async (mode: 'initial' | 'reload'): Promise<FunctionsDevelopmentResult> => {
    const controller = new AbortController();
    activeWait = controller;
    let connected: boolean;
    try {
      connected = await options.readiness.wait({
        timeoutMs: mode === 'initial'
          ? options.initialPeerTimeoutMs ?? INITIAL_PEER_TIMEOUT_MS
          : options.reloadPeerTimeoutMs ?? RELOAD_PEER_TIMEOUT_MS,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || closed) return { kind: 'no-peer' };
      return { kind: 'failed', error: asError(error) };
    } finally {
      if (activeWait === controller) activeWait = null;
    }
    if (!connected || closed) return { kind: 'no-peer' };

    let handle: FunctionsRtdbChildHandle;
    try {
      handle = spawn({
        cwd: options.sourceDir,
        entry: options.entry,
        env: buildChildEnv(options.baseEnv, {
          serveUrl: options.serveUrl,
          registerUrl: options.registerUrl,
        }),
        instance: options.instance,
        location: options.location,
        ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
        ...(options.childModuleUrl === undefined ? {} : { childModuleUrl: options.childModuleUrl }),
        onEvent: (event) => emit({ type: 'child-event', event }),
      });
    } catch (error) {
      return { kind: 'failed', error: asError(error) };
    }

    activeChild = handle;
    attachOutput(handle.child, emit);
    let readyReached = false;
    let exitBeforeReady: number | null = null;
    const reportUnexpectedExit = (code: number): void => {
      if (activeChild === handle && !closed && !expectedStops.has(handle)) {
        activeChild = null;
        emit({ type: 'unexpected-exit', code });
      }
    };
    void handle.exited.then((code) => {
      if (!readyReached) exitBeforeReady = code;
      else reportUnexpectedExit(code);
    });
    try {
      const ready = await handle.ready;
      readyReached = true;
      if (exitBeforeReady !== null) reportUnexpectedExit(exitBeforeReady);
      if (closed) {
        await stopChild(handle);
        return { kind: 'no-peer' };
      }
      return { kind: 'ready', ready };
    } catch (error) {
      await stopChild(handle);
      return { kind: 'failed', error: asError(error) };
    }
  };

  const runtime: FunctionsDevelopmentRuntime = {
    start() {
      startPromise ??= launch('initial');
      return startPromise;
    },
    reload() {
      if (closed) return Promise.resolve({ kind: 'failed', error: new Error('Functions runtime is closed') });
      reloadQueued = true;
      if (!reloadPromise) {
        reloadPromise = (async (): Promise<FunctionsDevelopmentResult> => {
          let result: FunctionsDevelopmentResult = { kind: 'no-peer' };
          if (startPromise) await startPromise;
          do {
            reloadQueued = false;
            await stopChild(activeChild);
            if (closed) return { kind: 'no-peer' };
            result = await launch('reload');
          } while (reloadQueued && !closed);
          return result;
        })().finally(() => { reloadPromise = null; });
      }
      return reloadPromise as Promise<FunctionsDevelopmentResult>;
    },
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        closed = true;
        reloadQueued = false;
        activeWait?.abort();
        await stopChild(activeChild);
        await Promise.allSettled([
          ...(startPromise ? [startPromise] : []),
          ...(reloadPromise ? [reloadPromise] : []),
        ]);
        // A transition that crossed the closed check in the same turn may have
        // installed a child after the first capture. The stop is idempotent.
        await stopChild(activeChild);
      })();
      return closePromise;
    },
  };
  return runtime;
}
