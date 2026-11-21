/**
 * Queue execution host for `firebase-functions/v2/tasks` (`onTaskDispatched`):
 * enforces task ID deduplication/tombstoning, `scheduleDelaySeconds` / `scheduleTime`
 * scheduling with deterministic `drainTasks()` and zero hanging timers on `close()`,
 * `rateLimits.maxConcurrentDispatches`, `retryConfig.maxAttempts` retries,
 * `execution-log.ts` recording, and `pyric-admin/functions` sandbox bridge attachment.
 */
import { randomUUID } from 'node:crypto';
import { getClock, type LocalSandbox } from 'pyric/sandbox';
import {
  emitHandlerFired,
  emitTriggerDiscovered,
  type FunctionExecutionOutcome,
} from '../events.js';
import {
  recordFunctionExecution,
  type FunctionExecutionRecord,
} from '../execution-log.js';
import { DEFAULT_REGION } from '../http/discovery.js';
import {
  discoverTasksTriggers,
  parseQueueTargetName,
  resolveDiscoveredTaskTrigger,
  type DiscoveredTaskTrigger,
  type TasksRateLimits,
  type TasksRetryConfig,
} from './discovery.js';
import {
  executeTaskTriggerAttempt,
  normalizeTaskScheduledTime,
  serializeTaskPayloadWire,
  type TaskAttemptResult,
  type TaskAuthClaims,
  type TaskDispatchAttemptOptions,
} from './event.js';
import {
  attachSandboxTaskQueueDispatcher,
  computeMaxTotalTaskAttempts,
  createCodedTaskError,
  tasksRetryConfigToRecord,
  type AdminBridgeDeleteInput,
  type AdminBridgeEnqueueInput,
} from './sandbox-bridge.js';

const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,500}$/;

export interface EnqueueTaskOptions {
  id?: string;
  scheduleDelaySeconds?: number;
  scheduleTime?: string | Date | number;
  dispatchDeadlineSeconds?: number;
  headers?: Record<string, string>;
  uri?: string;
  extensionId?: string;
  locationId?: string;
  projectId?: string;
  auth?: TaskAuthClaims;
}

export interface DrainTasksOptions {
  flushDelayed?: boolean;
}

export interface EnqueuedTaskReceipt {
  id: string;
  exportName: string;
  queueName: string;
  location: string;
  scheduledTime: string;
  delayed: boolean;
}

interface TaskAttemptOutcomeSummary {
  status: 'fulfilled' | 'rejected';
  exportName: string;
  queueName: string;
  taskId: string;
  retryCount: number;
  executionCount: number;
  scheduledTime: string;
  statusCode: number;
  startedAt: number;
  durationMs: number;
  retryConfig: TasksRetryConfig;
  rateLimits: TasksRateLimits;
  error?: string;
  record?: FunctionExecutionRecord;
}

export interface TasksTriggerExecutionOptions {
  exported: Record<string, unknown>;
  defaultLocation?: string;
  projectId?: string;
  sandbox?: LocalSandbox;
  enableTimers?: boolean;
  now?: () => number | Promise<number>;
  onAttempt?(
    attemptResult: TaskAttemptResult,
    trigger: DiscoveredTaskTrigger,
    summary: TaskAttemptOutcomeSummary,
  ): void;
}

export interface TasksTriggerExecutionHost {
  readonly triggerCount: number;
  readonly ready: Promise<void>;
  readonly triggers: readonly DiscoveredTaskTrigger[];
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
  idle(): Promise<void>;
  close(): void;
}

interface PendingTaskEntry {
  id: string;
  trigger: DiscoveredTaskTrigger;
  location: string;
  wireData: unknown;
  scheduledTime: string;
  etaEpochMs: number;
  headers?: Record<string, string>;
  auth?: TaskAuthClaims;
  cancelled: boolean;
  dispatched: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

interface QueueState {
  seenIds: Set<string>;
  waiting: PendingTaskEntry[];
  delayedById: Map<string, PendingTaskEntry>;
  inFlightCount: number;
}

/** Start local execution host for discovered `onTaskDispatched` exports. */
export function startTasksTriggerExecution(
  options: TasksTriggerExecutionOptions,
): TasksTriggerExecutionHost {
  const defaultLocation = options.defaultLocation ?? DEFAULT_REGION;
  const enableTimers = options.enableTimers ?? true;
  const triggers = discoverTasksTriggers(options.exported, {
    defaultRegion: defaultLocation,
  });

  const queueStates = new Map<string, QueueState>();
  const activeRunPromises = new Set<Promise<void>>();
  let closed = false;

  const stateForQueue = (location: string, exportName: string): QueueState => {
    const key = `${location}/${exportName}`;
    let existing = queueStates.get(key);
    if (existing === undefined) {
      existing = {
        seenIds: new Set<string>(),
        waiting: [],
        delayedById: new Map<string, PendingTaskEntry>(),
        inFlightCount: 0,
      };
      queueStates.set(key, existing);
    }
    return existing;
  };

  const readNow = async (): Promise<number> => {
    if (options.now !== undefined) {
      return await options.now();
    }
    if (options.sandbox !== undefined) {
      return getClock(options.sandbox).now();
    }
    return Date.now();
  };

  const runSingleTaskWithRetries = async (entry: PendingTaskEntry): Promise<void> => {
    if (closed || entry.cancelled) return;
    const maxTotalAttempts = computeMaxTotalTaskAttempts(entry.trigger);
    let maxRetryMs: number | undefined;
    if (entry.trigger.retryConfig.maxRetrySeconds !== undefined) {
      maxRetryMs = entry.trigger.retryConfig.maxRetrySeconds * 1000;
    }

    let attemptIndex = 0;
    let previousResponse: number | undefined;
    let retryReason: string | undefined;
    let firstAttemptStartMs: number | undefined;

    while (attemptIndex < maxTotalAttempts && !closed && !entry.cancelled) {
      const startedAt = await readNow();
      if (firstAttemptStartMs === undefined) {
        firstAttemptStartMs = startedAt;
      } else if (maxRetryMs !== undefined && startedAt - firstAttemptStartMs > maxRetryMs) {
        break;
      }

      const startedWallMs = Date.now();
      const ref = `queues/${entry.trigger.exportName}/tasks/${entry.id}`;
      const params: Record<string, string> = {
        queueName: entry.trigger.exportName,
        taskId: entry.id,
        retryCount: String(attemptIndex),
        executionCount: String(attemptIndex),
        scheduledTime: entry.scheduledTime,
      };

      if (options.sandbox !== undefined) {
        emitTriggerDiscovered(options.sandbox, {
          exportName: entry.trigger.exportName,
          reference: ref,
          instance: entry.location,
        });
        emitHandlerFired(options.sandbox, {
          trigger: entry.trigger.exportName,
          ref,
          params,
        });
      }

      const attemptOptions: TaskDispatchAttemptOptions = {
        queueName: entry.trigger.exportName,
        taskId: entry.id,
        data: entry.wireData,
        scheduledTime: entry.scheduledTime,
        retryCount: attemptIndex,
        executionCount: attemptIndex,
      };
      if (previousResponse !== undefined) attemptOptions.previousResponse = previousResponse;
      if (retryReason !== undefined) attemptOptions.retryReason = retryReason;
      if (entry.headers !== undefined) attemptOptions.headers = entry.headers;
      if (entry.auth !== undefined) attemptOptions.auth = entry.auth;
      if (options.projectId !== undefined) attemptOptions.projectId = options.projectId;

      const attemptResult = await executeTaskTriggerAttempt(entry.trigger, attemptOptions);
      const durationMs = Math.max(0, Date.now() - startedWallMs);
      const retryRecord = tasksRetryConfigToRecord(entry.trigger.retryConfig);

      const summary: TaskAttemptOutcomeSummary = {
        status: attemptResult.status,
        exportName: entry.trigger.exportName,
        queueName: entry.trigger.exportName,
        taskId: entry.id,
        retryCount: attemptIndex,
        executionCount: attemptIndex,
        scheduledTime: entry.scheduledTime,
        statusCode: attemptResult.statusCode,
        startedAt,
        durationMs,
        retryConfig: { ...entry.trigger.retryConfig },
        rateLimits: { ...entry.trigger.rateLimits },
      };
      if (attemptResult.status === 'rejected') {
        summary.error = attemptResult.error.message;
      }

      if (options.sandbox !== undefined) {
        const outcome: FunctionExecutionOutcome = {
          trigger: entry.trigger.exportName,
          ref,
          params,
          startedAt,
          durationMs,
          status: attemptResult.status,
        };
        if (attemptResult.status === 'fulfilled') {
          outcome.result = attemptResult.result;
        } else {
          outcome.error = attemptResult.error.message;
        }
        if (Object.keys(retryRecord).length > 0) {
          outcome.retryConfig = retryRecord;
        }
        summary.record = recordFunctionExecution(options.sandbox, outcome);
      }

      options.onAttempt?.(attemptResult, entry.trigger, summary);
      if (attemptResult.status === 'fulfilled') return;

      previousResponse = attemptResult.statusCode;
      retryReason = attemptResult.error.message;
      attemptIndex += 1;
    }
  };

  const pumpQueue = (state: QueueState): void => {
    if (closed) return;
    while (state.waiting.length > 0 && !closed) {
      const next = state.waiting[0];
      if (next === undefined) break;
      if (next.cancelled) {
        state.waiting.shift();
        continue;
      }
      const maxConcurrent = next.trigger.rateLimits.maxConcurrentDispatches ?? 1000;
      if (state.inFlightCount >= maxConcurrent) break;

      state.waiting.shift();
      next.dispatched = true;
      state.inFlightCount += 1;

      const tracked = runSingleTaskWithRetries(next).finally(() => {
        state.inFlightCount = Math.max(0, state.inFlightCount - 1);
        activeRunPromises.delete(tracked);
        if (!closed) pumpQueue(state);
      });
      activeRunPromises.add(tracked);
    }
  };

  const promoteDueDelayedTasks = (nowMs: number, flushDelayed: boolean): void => {
    for (const state of queueStates.values()) {
      for (const [taskId, entry] of state.delayedById.entries()) {
        if (entry.cancelled) {
          if (entry.timer !== undefined) clearTimeout(entry.timer);
          entry.timer = undefined;
          state.delayedById.delete(taskId);
          continue;
        }
        if (flushDelayed || entry.etaEpochMs <= nowMs) {
          if (entry.timer !== undefined) clearTimeout(entry.timer);
          entry.timer = undefined;
          state.delayedById.delete(taskId);
          state.waiting.push(entry);
        }
      }
      pumpQueue(state);
    }
  };

  const resolveTriggerOrThrow = (
    targetName: string,
    selectorOpts: { extensionId?: string; locationId?: string; projectId?: string } = {},
  ): { trigger: DiscoveredTaskTrigger; location: string } => {
    const parsed = parseQueueTargetName(targetName, selectorOpts.extensionId);
    if (selectorOpts.locationId !== undefined && parsed.locationId === undefined) {
      parsed.locationId = selectorOpts.locationId;
    }
    if (selectorOpts.projectId !== undefined && parsed.projectId === undefined) {
      parsed.projectId = selectorOpts.projectId;
    }
    const trigger = resolveDiscoveredTaskTrigger(triggers, parsed, options.projectId);
    if (trigger === undefined) {
      throw createCodedTaskError(
        'functions/not-found',
        `Task queue function '${parsed.queueName}' is not an active onTaskDispatched export`,
      );
    }
    const effectiveLocation = parsed.locationId ?? trigger.location ?? defaultLocation;
    return { trigger, location: effectiveLocation };
  };

  const enqueueTask = async (
    targetName: string,
    data?: unknown,
    enqueueOptions: EnqueueTaskOptions = {},
  ): Promise<EnqueuedTaskReceipt> => {
    if (closed) {
      throw createCodedTaskError('functions/aborted', 'Functions tasks execution host is closed');
    }
    if (
      enqueueOptions.scheduleDelaySeconds !== undefined &&
      enqueueOptions.scheduleTime !== undefined
    ) {
      throw createCodedTaskError(
        'functions/invalid-argument',
        'Both scheduleTime and scheduleDelaySeconds are provided. Only one value should be set.',
      );
    }
    if (
      enqueueOptions.scheduleDelaySeconds !== undefined &&
      (!Number.isFinite(enqueueOptions.scheduleDelaySeconds) ||
        enqueueOptions.scheduleDelaySeconds < 0)
    ) {
      throw createCodedTaskError(
        'functions/invalid-argument',
        'scheduleDelaySeconds must be a non-negative number',
      );
    }
    if (enqueueOptions.id !== undefined && !TASK_ID_PATTERN.test(enqueueOptions.id)) {
      throw createCodedTaskError(
        'functions/invalid-argument',
        `Invalid task id '${enqueueOptions.id}'`,
      );
    }

    const resolveOpts: { extensionId?: string; locationId?: string; projectId?: string } = {};
    if (enqueueOptions.extensionId !== undefined) resolveOpts.extensionId = enqueueOptions.extensionId;
    if (enqueueOptions.locationId !== undefined) resolveOpts.locationId = enqueueOptions.locationId;
    if (enqueueOptions.projectId !== undefined) resolveOpts.projectId = enqueueOptions.projectId;

    const { trigger, location } = resolveTriggerOrThrow(targetName, resolveOpts);
    const state = stateForQueue(location, trigger.exportName);

    const taskId = enqueueOptions.id ?? randomUUID().replace(/-/g, '');
    if (enqueueOptions.id !== undefined && state.seenIds.has(taskId)) {
      throw createCodedTaskError(
        'functions/task-already-exists',
        `A task with ID ${taskId} already exists`,
      );
    }

    const wireData = serializeTaskPayloadWire(data);
    const nowMs = await readNow();
    let etaEpochMs = nowMs;
    let scheduledTime: string;
    if (enqueueOptions.scheduleTime !== undefined) {
      scheduledTime = normalizeTaskScheduledTime(enqueueOptions.scheduleTime, nowMs);
      etaEpochMs = Date.parse(scheduledTime);
    } else if (enqueueOptions.scheduleDelaySeconds !== undefined) {
      etaEpochMs = nowMs + enqueueOptions.scheduleDelaySeconds * 1000;
      scheduledTime = new Date(etaEpochMs).toISOString();
    } else {
      scheduledTime = new Date(nowMs).toISOString();
    }

    state.seenIds.add(taskId);
    const entry: PendingTaskEntry = {
      id: taskId,
      trigger,
      location,
      wireData,
      scheduledTime,
      etaEpochMs,
      cancelled: false,
      dispatched: false,
    };
    if (enqueueOptions.headers !== undefined) entry.headers = { ...enqueueOptions.headers };
    if (enqueueOptions.auth !== undefined) entry.auth = enqueueOptions.auth;

    const delayMs = etaEpochMs - nowMs;
    if (delayMs > 0) {
      state.delayedById.set(taskId, entry);
      if (enableTimers) {
        const boundedDelayMs = Math.min(delayMs, 2_147_483_647);
        const timer = setTimeout(() => {
          entry.timer = undefined;
          if (closed || entry.cancelled) return;
          if (state.delayedById.delete(taskId)) {
            state.waiting.push(entry);
            pumpQueue(state);
          }
        }, boundedDelayMs);
        timer.unref?.();
        entry.timer = timer;
      }
      return {
        id: taskId,
        exportName: trigger.exportName,
        queueName: trigger.exportName,
        location,
        scheduledTime,
        delayed: true,
      };
    }

    state.waiting.push(entry);
    pumpQueue(state);
    return {
      id: taskId,
      exportName: trigger.exportName,
      queueName: trigger.exportName,
      location,
      scheduledTime,
      delayed: false,
    };
  };

  const deleteTask = async (
    targetName: string,
    taskId: string,
    deleteOpts: { extensionId?: string; locationId?: string; projectId?: string } = {},
  ): Promise<boolean> => {
    if (closed) {
      throw createCodedTaskError('functions/aborted', 'Functions tasks execution host is closed');
    }
    if (!TASK_ID_PATTERN.test(taskId)) {
      throw createCodedTaskError('functions/invalid-argument', `Invalid task id '${taskId}'`);
    }
    const { trigger, location } = resolveTriggerOrThrow(targetName, deleteOpts);
    const state = stateForQueue(location, trigger.exportName);

    const delayed = state.delayedById.get(taskId);
    if (delayed !== undefined) {
      delayed.cancelled = true;
      if (delayed.timer !== undefined) clearTimeout(delayed.timer);
      delayed.timer = undefined;
      state.delayedById.delete(taskId);
      return true;
    }

    for (let idx = 0; idx < state.waiting.length; idx += 1) {
      const candidate = state.waiting[idx];
      if (candidate !== undefined && candidate.id === taskId && !candidate.dispatched) {
        candidate.cancelled = true;
        state.waiting.splice(idx, 1);
        return true;
      }
    }
    return false;
  };

  const idle = async (): Promise<void> => {
    while (activeRunPromises.size > 0) {
      await Promise.allSettled(Array.from(activeRunPromises));
    }
  };

  const drainTasks = async (drainOptions: DrainTasksOptions = {}): Promise<void> => {
    const flushDelayed = drainOptions.flushDelayed ?? false;
    while (!closed) {
      const nowMs = await readNow();
      promoteDueDelayedTasks(nowMs, flushDelayed);
      if (activeRunPromises.size === 0) break;
      await idle();
    }
  };

  let detachSandboxDispatcher: (() => void) | undefined;
  if (options.sandbox !== undefined) {
    detachSandboxDispatcher = attachSandboxTaskQueueDispatcher(options.sandbox, {
      async enqueue(request: AdminBridgeEnqueueInput): Promise<void> {
        const mappedOpts: EnqueueTaskOptions = {};
        if (request.id !== undefined) mappedOpts.id = request.id;
        if (request.scheduleDelaySeconds !== undefined) {
          mappedOpts.scheduleDelaySeconds = request.scheduleDelaySeconds;
        }
        if (request.scheduleTimeIso !== undefined) mappedOpts.scheduleTime = request.scheduleTimeIso;
        if (request.dispatchDeadlineSeconds !== undefined) {
          mappedOpts.dispatchDeadlineSeconds = request.dispatchDeadlineSeconds;
        }
        if (request.headers !== undefined) mappedOpts.headers = request.headers;
        if (request.uri !== undefined) mappedOpts.uri = request.uri;
        if (request.locationId !== undefined) mappedOpts.locationId = request.locationId;
        if (request.projectId !== undefined) mappedOpts.projectId = request.projectId;
        await enqueueTask(request.queueName, request.data, mappedOpts);
      },
      async delete(request: AdminBridgeDeleteInput): Promise<void> {
        const delOpts: { locationId?: string; projectId?: string } = {};
        if (request.locationId !== undefined) delOpts.locationId = request.locationId;
        if (request.projectId !== undefined) delOpts.projectId = request.projectId;
        await deleteTask(request.queueName, request.id, delOpts);
      },
    });
  }

  return {
    triggerCount: triggers.length,
    ready: Promise.resolve(),
    triggers,
    enqueueTask,
    deleteTask,
    drainTasks,
    idle,
    close() {
      if (closed) return;
      closed = true;
      detachSandboxDispatcher?.();
      for (const state of queueStates.values()) {
        for (const delayed of state.delayedById.values()) {
          delayed.cancelled = true;
          if (delayed.timer !== undefined) clearTimeout(delayed.timer);
          delayed.timer = undefined;
        }
        state.delayedById.clear();
        for (const queued of state.waiting) {
          queued.cancelled = true;
        }
        state.waiting.length = 0;
      }
    },
  };
}
