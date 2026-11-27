/**
 * Multi-codebase Functions development runtime coordinator.
 *
 * Extracted as a sibling of `development-runtime.ts` so every module stays
 * compact (<= 600 lines) while supporting `firebase.json` multi-codebase arrays
 * (`functions: [{ codebase: 'a', source: '...' }, { codebase: 'b', source: '...' }]`):
 *  - Each codebase runs in its own isolated child process with its own
 *    `sourceDir`, `.env` / `.secret.local`, `node_modules`, ADC dir, HTTP port,
 *    and spawn token.
 *  - Duplicate export names across codebases fail fast with a clear diagnostic
 *    and cleanly tear down all spawned children without orphan processes.
 *  - `codebase` metadata is preserved across trigger listings, HTTP backends,
 *    output prefixes, child events, and recorded execution logs.
 */
import type { FunctionsChildReady } from './child-protocol.js';
import type {
  FunctionsDevelopmentEvent,
  FunctionsDevelopmentResult,
  FunctionsDevelopmentRuntimeHandle,
  FunctionsDevelopmentRuntimeOptions,
} from './development-runtime.js';
import {
  collectCodebaseExportNames,
  findDuplicateCodebaseExports,
  formatDuplicateCodebaseExportsError,
  mergeCodebaseReadySnapshots,
  type CodebaseReadySnapshot,
} from './multi-codebase-metadata.js';
import type { FunctionsCodebaseProject } from './project.js';
import type { PubSubPublishResult } from './pubsub/delivery.js';
import type { PubSubPublishAttributesOrOptions } from './pubsub/event.js';
import type {
  ScheduledTriggerInvocationResult,
  TriggerScheduledOptions,
} from './scheduler/execution.js';
import { attachSandboxTaskQueueDispatcher } from './tasks/sandbox-bridge.js';
import type {
  DrainTasksOptions,
  EnqueueTaskOptions,
  EnqueuedTaskReceipt,
} from './tasks/execution.js';

export {
  findDuplicateCodebaseExports,
  formatDuplicateCodebaseExportsError,
  mergeCodebaseReadySnapshots,
  recordPubSubDeliveries,
  recordScheduledExecution,
  tagChildEventWithCodebase,
  tagReadyWithCodebase,
  type CodebaseReadySnapshot,
  type DuplicateCodebaseExport,
} from './multi-codebase-metadata.js';

const INITIAL_PEER_TIMEOUT_MS = 30_000;
const RELOAD_PEER_TIMEOUT_MS = 5_000;

export type SingleCodebaseRuntimeFactory = (
  options: FunctionsDevelopmentRuntimeOptions & {
    labelWithCodebase?: boolean;
    includeExportMetadata?: boolean;
    skipSandboxTaskBridge?: boolean;
  },
) => FunctionsDevelopmentRuntimeHandle;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isNotFoundTaskError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate.code === 'functions/not-found') return true;
  if (typeof candidate.message === 'string' && /not found|does not exist/i.test(candidate.message)) {
    return true;
  }
  return false;
}

/**
 * Coordinate multiple isolated per-codebase Functions development runtimes
 * behind a single `FunctionsDevelopmentRuntimeHandle`.
 */
export function createMultiCodebaseFunctionsDevelopmentRuntime(
  options: FunctionsDevelopmentRuntimeOptions,
  codebases: readonly FunctionsCodebaseProject[],
  createSingle: SingleCodebaseRuntimeFactory,
): FunctionsDevelopmentRuntimeHandle {
  const emit = (event: FunctionsDevelopmentEvent): void => options.onEvent?.(event);
  const immediateReadiness = { wait: () => Promise.resolve(true) };

  let closed = false;
  let activeWait: AbortController | null = null;
  let startPromise: Promise<FunctionsDevelopmentResult> | null = null;
  let reloadPromise: Promise<FunctionsDevelopmentResult> | null = null;
  let reloadQueued = false;
  let closePromise: Promise<void> | null = null;
  let suppressingChildRestarts = false;

  const latestReady = new Map<string, FunctionsChildReady>();
  const runtimes = new Map<string, FunctionsDevelopmentRuntimeHandle>();

  const buildMergedReadyOrError = ():
    | { ok: true; ready: FunctionsChildReady }
    | { ok: false; error: Error } => {
    const snapshots: CodebaseReadySnapshot[] = [];
    for (const cb of codebases) {
      const ready = latestReady.get(cb.codebase);
      if (ready !== undefined) {
        snapshots.push({ codebase: cb, ready });
      }
    }
    const duplicates = findDuplicateCodebaseExports(snapshots);
    if (duplicates.length > 0) {
      return { ok: false, error: formatDuplicateCodebaseExportsError(duplicates) };
    }
    return { ok: true, ready: mergeCodebaseReadySnapshots(snapshots) };
  };

  const buildChildRuntime = (cb: FunctionsCodebaseProject): FunctionsDevelopmentRuntimeHandle =>
    createSingle({
      ...options,
      sourceDir: cb.sourceDir,
      entry: cb.entry,
      codebase: cb.codebase,
      codebases: undefined,
      readiness: immediateReadiness,
      labelWithCodebase: true,
      includeExportMetadata: true,
      skipSandboxTaskBridge: true,
      onEvent: (event) => {
        if (closed) return;
        if (event.type === 'starting') return;
        if (event.type === 'restarted') {
          if (suppressingChildRestarts) return;
          if (event.result.kind === 'ready') {
            latestReady.set(cb.codebase, event.result.ready);
            const merged = buildMergedReadyOrError();
            if (merged.ok) {
              emit({ type: 'restarted', result: { kind: 'ready', ready: merged.ready } });
            } else {
              emit({ type: 'restarted', result: { kind: 'failed', error: merged.error } });
            }
          } else {
            latestReady.delete(cb.codebase);
            emit(event);
          }
          return;
        }
        emit(event);
      },
    });

  const stopAllChildren = async (): Promise<void> => {
    suppressingChildRestarts = true;
    try {
      const active = [...runtimes.values()];
      runtimes.clear();
      latestReady.clear();
      await Promise.allSettled(active.map((rt) => rt.close()));
    } finally {
      suppressingChildRestarts = false;
    }
  };

  const ensureFreshChildren = (): void => {
    for (const cb of codebases) {
      if (!runtimes.has(cb.codebase)) {
        runtimes.set(cb.codebase, buildChildRuntime(cb));
      }
    }
  };

  const launchAll = async (mode: 'initial' | 'reload'): Promise<FunctionsDevelopmentResult> => {
    const controller = new AbortController();
    activeWait = controller;
    let connected: boolean;
    try {
      connected = await options.readiness.wait({
        timeoutMs:
          mode === 'initial'
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
    if (mode === 'reload') {
      await stopAllChildren();
      if (closed) return { kind: 'no-peer' };
    }
    ensureFreshChildren();

    const settled = await Promise.all(
      codebases.map(async (cb) => {
        const rt = runtimes.get(cb.codebase)!;
        const result = await rt.start();
        return { cb, result };
      }),
    );

    if (closed) {
      await stopAllChildren();
      return { kind: 'no-peer' };
    }

    for (const { cb, result } of settled) {
      if (result.kind === 'failed') {
        await stopAllChildren();
        const message = result.error.message.includes(cb.codebase)
          ? result.error.message
          : `[codebase "${cb.codebase}"] ${result.error.message}`;
        return { kind: 'failed', error: new Error(message) };
      }
      if (result.kind === 'no-peer') {
        await stopAllChildren();
        return { kind: 'no-peer' };
      }
    }

    latestReady.clear();
    const snapshots: CodebaseReadySnapshot[] = [];
    for (const { cb, result } of settled) {
      if (result.kind === 'ready') {
        latestReady.set(cb.codebase, result.ready);
        snapshots.push({ codebase: cb, ready: result.ready });
      }
    }

    const duplicates = findDuplicateCodebaseExports(snapshots);
    if (duplicates.length > 0) {
      await stopAllChildren();
      return { kind: 'failed', error: formatDuplicateCodebaseExportsError(duplicates) };
    }

    return { kind: 'ready', ready: mergeCodebaseReadySnapshots(snapshots) };
  };

  const findCodebaseOwningExport = (exportName: string): string | undefined => {
    for (const cb of codebases) {
      const ready = latestReady.get(cb.codebase);
      if (ready !== undefined && collectCodebaseExportNames(ready).includes(exportName)) {
        return cb.codebase;
      }
    }
    return undefined;
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
          if (closed) return { kind: 'no-peer' };
          result = await launchAll('reload');
        } while (reloadQueued && !closed);
        return result;
      })()
        .then((result) => {
          startPromise = result.kind === 'ready' ? Promise.resolve(result) : null;
          return result;
        })
        .finally(() => {
          reloadPromise = null;
        });
    }
    return reloadPromise;
  };

  const handle: FunctionsDevelopmentRuntimeHandle = {
    start() {
      if (closed) {
        return Promise.resolve({ kind: 'failed', error: new Error('Functions runtime is closed') });
      }
      if (reloadPromise !== null) return reloadPromise;
      startPromise ??= launchAll('initial').then((result) => {
        if (result.kind !== 'ready') startPromise = null;
        return result;
      });
      return startPromise;
    },
    reload() {
      if (closed) {
        return Promise.resolve({ kind: 'failed', error: new Error('Functions runtime is closed') });
      }
      return reloadInternal();
    },
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        closed = true;
        detachTaskBridge?.();
        reloadQueued = false;
        activeWait?.abort();
        await stopAllChildren();
        await Promise.allSettled([
          ...(startPromise ? [startPromise] : []),
          ...(reloadPromise ? [reloadPromise] : []),
        ]);
        await stopAllChildren();
      })();
      return closePromise;
    },
    async triggerScheduled(
      exportName: string,
      invokeOptions: TriggerScheduledOptions = {},
    ): Promise<ScheduledTriggerInvocationResult> {
      if (closed) throw new Error('Functions runtime is closed');
      const owner = findCodebaseOwningExport(exportName);
      if (owner !== undefined) {
        const active = runtimes.get(owner);
        if (active === undefined) {
          throw new Error(`Functions runtime codebase "${owner}" is not active`);
        }
        return active.triggerScheduled(exportName, invokeOptions);
      }
      let lastError: unknown;
      for (const cb of codebases) {
        const active = runtimes.get(cb.codebase);
        if (active === undefined) continue;
        try {
          return await active.triggerScheduled(exportName, invokeOptions);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error(`Scheduled trigger "${exportName}" was not found in any codebase`);
    },
    async publishPubSub(
      topic: string,
      payload?: unknown,
      attributes?: PubSubPublishAttributesOrOptions,
    ): Promise<PubSubPublishResult> {
      if (closed) throw new Error('Functions runtime is closed');
      const activeRuntimes = codebases
        .map((cb) => runtimes.get(cb.codebase))
        .filter((rt): rt is FunctionsDevelopmentRuntimeHandle => rt !== undefined);
      if (activeRuntimes.length === 0) {
        throw new Error('Functions runtime has no active child process');
      }
      const results: PubSubPublishResult[] = [];
      for (const active of activeRuntimes) {
        results.push(await active.publishPubSub(topic, payload, attributes));
      }
      const first = results[0]!;
      return {
        ...first,
        deliveries: results.flatMap((res) => res.deliveries),
      };
    },
    async enqueueTask(
      targetName: string,
      data?: unknown,
      enqueueOptions: EnqueueTaskOptions = {},
    ): Promise<EnqueuedTaskReceipt> {
      if (closed) throw new Error('Functions runtime is closed');
      const owner = findCodebaseOwningExport(targetName);
      if (owner !== undefined) {
        const active = runtimes.get(owner);
        if (active === undefined) throw new Error('Functions runtime has no active child process');
        return active.enqueueTask(targetName, data, enqueueOptions);
      }
      let lastError: unknown;
      for (const cb of codebases) {
        const active = runtimes.get(cb.codebase);
        if (active === undefined) continue;
        try {
          return await active.enqueueTask(targetName, data, enqueueOptions);
        } catch (error) {
          lastError = error;
          if (!isNotFoundTaskError(error)) throw error;
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error(`Task queue "${targetName}" was not found in any codebase`);
    },
    async deleteTask(
      targetName: string,
      taskId: string,
      deleteOptions?: { extensionId?: string; locationId?: string; projectId?: string },
    ): Promise<boolean> {
      if (closed) throw new Error('Functions runtime is closed');
      const owner = findCodebaseOwningExport(targetName);
      if (owner !== undefined) {
        const active = runtimes.get(owner);
        if (active === undefined) throw new Error('Functions runtime has no active child process');
        return active.deleteTask(targetName, taskId, deleteOptions);
      }
      let lastError: unknown;
      for (const cb of codebases) {
        const active = runtimes.get(cb.codebase);
        if (active === undefined) continue;
        try {
          return await active.deleteTask(targetName, taskId, deleteOptions);
        } catch (error) {
          lastError = error;
          if (!isNotFoundTaskError(error)) throw error;
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error(`Task queue "${targetName}" was not found in any codebase`);
    },
    async drainTasks(drainOptions: DrainTasksOptions = {}): Promise<void> {
      if (closed) throw new Error('Functions runtime is closed');
      const activeRuntimes = codebases
        .map((cb) => runtimes.get(cb.codebase))
        .filter((rt): rt is FunctionsDevelopmentRuntimeHandle => rt !== undefined);
      if (activeRuntimes.length === 0) {
        throw new Error('Functions runtime has no active child process');
      }
      await Promise.all(activeRuntimes.map((active) => active.drainTasks(drainOptions)));
    },
  };

  let detachTaskBridge: (() => void) | undefined;
  if (options.sandbox !== undefined) {
    detachTaskBridge = attachSandboxTaskQueueDispatcher(options.sandbox, {
      async enqueue(request) {
        const opts: EnqueueTaskOptions = {};
        if (request.id !== undefined) opts.id = request.id;
        if (request.scheduleDelaySeconds !== undefined) {
          opts.scheduleDelaySeconds = request.scheduleDelaySeconds;
        }
        if (request.scheduleTimeIso !== undefined) opts.scheduleTime = request.scheduleTimeIso;
        if (request.dispatchDeadlineSeconds !== undefined) {
          opts.dispatchDeadlineSeconds = request.dispatchDeadlineSeconds;
        }
        if (request.headers !== undefined) opts.headers = request.headers;
        if (request.uri !== undefined) opts.uri = request.uri;
        if (request.locationId !== undefined) opts.locationId = request.locationId;
        if (request.projectId !== undefined) opts.projectId = request.projectId;
        await handle.enqueueTask(request.queueName, request.data, opts);
      },
      async delete(request) {
        const delOpts: { locationId?: string; projectId?: string } = {};
        if (request.locationId !== undefined) delOpts.locationId = request.locationId;
        if (request.projectId !== undefined) delOpts.projectId = request.projectId;
        await handle.deleteTask(request.queueName, request.id, delOpts);
      },
    });
  }

  return handle;
}
