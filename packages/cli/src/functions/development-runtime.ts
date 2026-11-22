import type { ChildProcess } from 'node:child_process';
import type { LocalSandbox } from 'pyric/sandbox';
import type { FunctionsChildEvent, FunctionsChildReady } from './child-protocol.js';
import { createCrashRestartController } from './crash-restart.js';
import { recordFunctionExecution } from './execution-log.js';
import { sendChildPublishPubSub } from './pubsub/child-runtime.js';
import type { PubSubPublishResult } from './pubsub/delivery.js';
import type { PubSubPublishAttributesOrOptions } from './pubsub/event.js';
import { sendChildTriggerScheduled } from './scheduler/child-runtime.js';
import {
  retryConfigToRecord,
  type ScheduledTriggerInvocationResult,
  type TriggerScheduledOptions,
} from './scheduler/execution.js';
import {
  spawnFunctionsChild,
  type FunctionsChildHandle,
  type SpawnFunctionsChildOptions,
} from './spawn.js';
import {
  attachDevelopmentRuntimeSandboxTaskBridge,
  recordChildTaskExecutionEvent,
  sendChildDeleteTask,
  sendChildDrainTasks,
  sendChildEnqueueTask,
} from './tasks/child-runtime.js';
import type {
  DrainTasksOptions,
  EnqueueTaskOptions,
  EnqueuedTaskReceipt,
} from './tasks/execution.js';
import { boundedFetch } from '../bounded-request.js';
import { buildChildEnv, createLinePrefixer } from '../cli/sandbox-runner.js';

const INITIAL_PEER_TIMEOUT_MS = 30_000;
const RELOAD_PEER_TIMEOUT_MS = 5_000;
const PEER_POLL_INTERVAL_MS = 250;
const PEER_POLL_DEADLINE_MS = 2_000;

export interface FunctionsPeerReadiness {
  wait(options: { timeoutMs: number; signal: AbortSignal }): Promise<boolean>;
}

export type FunctionsDevelopmentResult =
  | { kind: 'ready'; ready: FunctionsChildReady }
  | { kind: 'no-peer' }
  | { kind: 'failed'; error: Error };

export type FunctionsDevelopmentEvent =
  /** A sandbox peer is connected and the child is about to spawn. */
  | { type: 'starting'; mode: 'initial' | 'reload' }
  | { type: 'child-event'; event: FunctionsChildEvent }
  /** The child stopped beating: a handler is likely stuck in a synchronous loop. The runtime restarts it. */
  | { type: 'unresponsive' }
  /** How the restart after an unresponsive child ended. */
  | { type: 'restarted'; result: FunctionsDevelopmentResult }
  | { type: 'output'; stream: 'stdout' | 'stderr'; line: string }
  | { type: 'unexpected-exit'; code: number; restarting?: boolean };

export interface FunctionsDevelopmentRuntime {
  start(): Promise<FunctionsDevelopmentResult>;
  reload(): Promise<FunctionsDevelopmentResult>;
  close(): Promise<void>;
  triggerScheduled?(
    exportName: string,
    options?: TriggerScheduledOptions,
  ): Promise<ScheduledTriggerInvocationResult>;
  publishPubSub?(
    topic: string,
    payload?: unknown,
    attributes?: PubSubPublishAttributesOrOptions,
  ): Promise<PubSubPublishResult>;
  enqueueTask?(
    targetName: string,
    data?: unknown,
    options?: EnqueueTaskOptions,
  ): Promise<EnqueuedTaskReceipt>;
  deleteTask?(
    targetName: string,
    taskId: string,
    options?: { extensionId?: string; locationId?: string; projectId?: string },
  ): Promise<boolean>;
  drainTasks?(options?: DrainTasksOptions): Promise<void>;
}

export interface FunctionsDevelopmentRuntimeHandle extends FunctionsDevelopmentRuntime {
  triggerScheduled(
    exportName: string,
    options?: TriggerScheduledOptions,
  ): Promise<ScheduledTriggerInvocationResult>;
  publishPubSub(
    topic: string,
    payload?: unknown,
    attributes?: PubSubPublishAttributesOrOptions,
  ): Promise<PubSubPublishResult>;
  enqueueTask(
    targetName: string,
    data?: unknown,
    options?: EnqueueTaskOptions,
  ): Promise<EnqueuedTaskReceipt>;
  deleteTask(
    targetName: string,
    taskId: string,
    options?: { extensionId?: string; locationId?: string; projectId?: string },
  ): Promise<boolean>;
  drainTasks(options?: DrainTasksOptions): Promise<void>;
}

export interface FunctionsDevelopmentRuntimeOptions {
  sourceDir: string;
  entry: string;
  baseEnv: NodeJS.ProcessEnv;
  serveUrl: string;
  registerUrl: string;
  /** The per-launch secret this child's handshake beacon must present.
   *  Absent when the host runs no beacon receiver. */
  beaconToken?: string | undefined;
  /** Identity of the host at `serveUrl`, pinned in the child's
   *  `PYRIC_SANDBOX_INSTANCE`. */
  hostInstanceId?: string | undefined;
  /** Per-boot capability token passed to the isolated Functions child. */
  sessionToken?: string | undefined;
  instance: string;
  location: string;
  /** The project the child runs as, from `resolveFirebaseProject`. */
  projectId: string;
  childModuleUrl?: string | URL;
  readiness: FunctionsPeerReadiness;
  onEvent?(event: FunctionsDevelopmentEvent): void;
  /** Internal test seam; production adapters use the real isolated child. */
  spawn?(options: SpawnFunctionsChildOptions): FunctionsChildHandle;
  initialPeerTimeoutMs?: number;
  reloadPeerTimeoutMs?: number;
  /** Internal test seam for the child heartbeat watchdog. */
  heartbeatTimeoutMs?: number;
  /** Optional local sandbox for recording programmatic trigger executions. */
  sandbox?: LocalSandbox;
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
  const injectedFetch = options.fetchImpl;
  const intervalMs = options.intervalMs ?? PEER_POLL_INTERVAL_MS;
  const now = options.now ?? (() => performance.now());
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
          const remainingMs = deadline - now();
          if (remainingMs <= 0) return false;
          const pollDeadlineMs = Math.min(PEER_POLL_DEADLINE_MS, Math.max(1, remainingMs));
          const healthUrl = `${baseUrl}/__pyric/health`;
          try {
            let response: Response;
            if (injectedFetch !== undefined) {
              response = await settleBeforeAbort(
                injectedFetch(healthUrl, { signal: waitSignal }),
                waitSignal,
              );
            } else {
              response = await boundedFetch(healthUrl, {
                deadlineMs: pollDeadlineMs,
                signal: waitSignal,
              });
            }
            if (response.ok) {
              const health = await settleBeforeAbort(
                response.json() as Promise<{ sandboxConnected?: boolean }>,
                waitSignal,
              );
              if (health.sandboxConnected === true) return true;
            }
          } catch (error) {
            if (waitSignal.aborted) return false;
            const isProbeFailure =
              error instanceof Error || (typeof error === 'object' && error !== null && 'name' in error);
            if (!isProbeFailure) throw error;
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
): FunctionsDevelopmentRuntimeHandle {
  const spawn = options.spawn ?? spawnFunctionsChild;
  const emit = (event: FunctionsDevelopmentEvent): void => options.onEvent?.(event);
  const expectedStops = new WeakSet<FunctionsChildHandle>();
  let activeChild: FunctionsChildHandle | null = null;
  let activeWait: AbortController | null = null;
  let closed = false;
  let startPromise: Promise<FunctionsDevelopmentResult> | null = null;
  let reloadPromise: Promise<FunctionsDevelopmentResult> | null = null;
  let reloadQueued = false;
  let closePromise: Promise<void> | null = null;
  const detachSandboxTaskBridge = attachDevelopmentRuntimeSandboxTaskBridge(
    options.sandbox,
    () => activeChild?.child ?? null,
    () => closed,
  );

  const stopChild = async (child: FunctionsChildHandle | null): Promise<void> => {
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

    emit({ type: 'starting', mode });
    let handle: FunctionsChildHandle;
    try {
      handle = spawn({
        cwd: options.sourceDir,
        entry: options.entry,
        env: buildChildEnv(options.baseEnv, {
          serveUrl: options.serveUrl,
          registerUrl: options.registerUrl,
          beaconToken: options.beaconToken,
          instanceId: options.hostInstanceId,
          sessionToken: options.sessionToken,
        }),
        instance: options.instance,
        location: options.location,
        projectId: options.projectId,
        ...(options.childModuleUrl === undefined ? {} : { childModuleUrl: options.childModuleUrl }),
        onEvent: (event) => {
          recordChildTaskExecutionEvent(options.sandbox, event);
          emit({ type: 'child-event', event });
        },
        onUnresponsive: () => restartUnresponsive(),
        ...(options.heartbeatTimeoutMs === undefined ? {} : { heartbeatTimeoutMs: options.heartbeatTimeoutMs }),
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
        startPromise = null;
        const restarting = crashRestarts.scheduleAfterUnexpectedExit();
        emit({ type: 'unexpected-exit', code, restarting });
      }
    };
    void handle.exited.then((code) => {
      if (!readyReached) exitBeforeReady = code;
      else reportUnexpectedExit(code);
    });
    try {
      const ready = await handle.ready;
      readyReached = true;
      crashRestarts.markReady();
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

  const reloadInternal = (): Promise<FunctionsDevelopmentResult> => {
    if (closed) {
      return Promise.resolve({ kind: 'failed', error: new Error('Functions runtime is closed') });
    }
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
      })()
        .then((result) => {
          const ready = result.kind === 'ready';
          startPromise = ready ? Promise.resolve(result) : null;
          return result;
        })
        .finally(() => {
          reloadPromise = null;
        });
    }
    return reloadPromise;
  };

  const crashRestarts = createCrashRestartController({
    isClosed: () => closed,
    reload: async () => {
      const result = await reloadInternal();
      if (!closed) {
        emit({ type: 'restarted', result });
      }
    },
  });

  const restartUnresponsive = (): void => {
    if (closed) return;
    crashRestarts.cancelPending();
    emit({ type: 'unresponsive' });
    void reloadInternal().then((result) => {
      if (!closed) emit({ type: 'restarted', result });
    });
  };

  const runtime: FunctionsDevelopmentRuntimeHandle = {
    start() {
      if (closed) return Promise.resolve({ kind: 'failed', error: new Error('Functions runtime is closed') });
      const activeReload = reloadPromise;
      const reloading = activeReload !== null;
      if (reloading) return activeReload;
      startPromise ??= launch('initial').then(result => {
        const retryable = result.kind !== 'ready';
        if (retryable) startPromise = null;
        return result;
      });
      return startPromise;
    },
    reload() {
      if (closed) return Promise.resolve({ kind: 'failed', error: new Error('Functions runtime is closed') });
      crashRestarts.reset();
      return reloadInternal();
    },
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        closed = true;
        crashRestarts.cancelPending();
        detachSandboxTaskBridge?.();
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
    async triggerScheduled(
      exportName: string,
      invokeOptions: TriggerScheduledOptions = {},
    ): Promise<ScheduledTriggerInvocationResult> {
      if (closed) {
        throw new Error('Functions runtime is closed');
      }
      if (activeChild === null) {
        throw new Error('Functions runtime has no active child process');
      }
      const summary = await sendChildTriggerScheduled(
        activeChild.child,
        exportName,
        invokeOptions,
      );
      if (options.sandbox !== undefined) {
        const ref = summary.jobName ?? `schedule/${summary.exportName}`;
        const params: Record<string, string> = {
          scheduleTime: summary.scheduleTime,
        };
        const retryRecord = retryConfigToRecord(summary.retryConfig);
        const outcome: {
          trigger: string;
          ref: string;
          params: Record<string, string>;
          startedAt: number;
          durationMs: number;
          status: 'fulfilled' | 'rejected';
          result?: unknown;
          error?: string;
          retryConfig?: Record<string, number>;
        } = {
          trigger: summary.exportName,
          ref,
          params,
          startedAt: summary.startedAt,
          durationMs: summary.durationMs,
          status: summary.status,
        };
        if (summary.status === 'fulfilled') {
          outcome.result = summary.result;
        } else {
          outcome.error = summary.error;
        }
        if (Object.keys(retryRecord).length > 0) {
          outcome.retryConfig = retryRecord;
        }
        summary.record = recordFunctionExecution(options.sandbox, outcome);
      }
      return summary;
    },
    async publishPubSub(
      topic: string,
      payload?: unknown,
      attributes?: PubSubPublishAttributesOrOptions,
    ): Promise<PubSubPublishResult> {
      if (closed) {
        throw new Error('Functions runtime is closed');
      }
      if (activeChild === null) {
        throw new Error('Functions runtime has no active child process');
      }
      const summary = await sendChildPublishPubSub(
        activeChild.child,
        topic,
        payload,
        attributes,
        options.projectId,
      );
      if (options.sandbox !== undefined) {
        for (const delivery of summary.deliveries) {
          const outcome: {
            trigger: string;
            ref: string;
            params: Record<string, string>;
            startedAt: number;
            durationMs: number;
            status: 'fulfilled' | 'rejected';
            result?: unknown;
            error?: string;
            retryConfig?: Record<string, number>;
          } = {
            trigger: delivery.exportName,
            ref: summary.topicResource,
            params: {
              topic: summary.topic,
              messageId: summary.messageId,
            },
            startedAt: delivery.startedAt,
            durationMs: delivery.durationMs,
            status: delivery.status,
          };
          if (delivery.status === 'fulfilled') {
            if (delivery.result !== undefined) {
              outcome.result = delivery.result;
            }
          } else {
            outcome.error = delivery.error?.message ?? 'Unknown error';
          }
          if (delivery.retry) {
            outcome.retryConfig = { retry: 1 };
          }
          recordFunctionExecution(options.sandbox, outcome);
        }
      }
      return summary;
    },
    async enqueueTask(
      targetName: string,
      data?: unknown,
      enqueueOptions: EnqueueTaskOptions = {},
    ): Promise<EnqueuedTaskReceipt> {
      if (closed) throw new Error('Functions runtime is closed');
      if (activeChild === null) throw new Error('Functions runtime has no active child process');
      return sendChildEnqueueTask(activeChild.child, targetName, data, enqueueOptions);
    },
    async deleteTask(
      targetName: string,
      taskId: string,
      deleteOptions?: { extensionId?: string; locationId?: string; projectId?: string },
    ): Promise<boolean> {
      if (closed) throw new Error('Functions runtime is closed');
      if (activeChild === null) throw new Error('Functions runtime has no active child process');
      return sendChildDeleteTask(activeChild.child, targetName, taskId, deleteOptions);
    },
    async drainTasks(drainOptions: DrainTasksOptions = {}): Promise<void> {
      if (closed) throw new Error('Functions runtime is closed');
      if (activeChild === null) throw new Error('Functions runtime has no active child process');
      await sendChildDrainTasks(activeChild.child, drainOptions);
    },
  };
  return runtime;
}
