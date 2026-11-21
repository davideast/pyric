/**
 * The v2 Cloud Tasks (`onTaskDispatched`) trigger family inside the isolated
 * Functions child: installs `PROCESS_TASK_QUEUE_DISPATCHER` so `pyric-admin/functions`
 * `getFunctions().taskQueue(name).enqueue(...)` / `.delete(id)` inside any Cloud
 * Function dispatches directly in-child, handles host IPC requests, and emits
 * execution events back to the host.
 */
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { LocalSandbox } from 'pyric/sandbox';
import type { RemoteSandbox } from '../../remote/index.js';
import { serializeError, type FunctionsChildEvent } from '../child-protocol.js';
import type { FunctionExecutionOutcome } from '../events.js';
import { recordFunctionExecution } from '../execution-log.js';
import type { TaskAttemptResult } from './event.js';
import {
  startTasksTriggerExecution,
  type DrainTasksOptions,
  type EnqueueTaskOptions,
  type EnqueuedTaskReceipt,
  type TasksTriggerExecutionHost,
} from './execution.js';
import {
  attachSandboxTaskQueueDispatcher,
  tasksRetryConfigToRecord,
} from './sandbox-bridge.js';

const PROCESS_TASK_QUEUE_DISPATCHER = Symbol.for('pyric.functions.processTaskQueueDispatcher');

interface EnqueueTaskHostRequest {
  type: 'enqueue-task';
  requestId: string;
  targetName: string;
  data?: unknown;
  options?: EnqueueTaskOptions;
}

interface DeleteTaskHostRequest {
  type: 'delete-task';
  requestId: string;
  targetName: string;
  taskId: string;
  options?: {
    extensionId?: string;
    locationId?: string;
    projectId?: string;
  };
}

interface DrainTasksHostRequest {
  type: 'drain-tasks';
  requestId: string;
  flushDelayed?: boolean;
}

export type TasksHostRequest =
  | EnqueueTaskHostRequest
  | DeleteTaskHostRequest
  | DrainTasksHostRequest;

export type TasksChildResult =
  | {
      type: 'tasks-op-result';
      requestId: string;
      outcome: 'enqueued';
      receipt: EnqueuedTaskReceipt;
    }
  | {
      type: 'tasks-op-result';
      requestId: string;
      outcome: 'deleted';
      deleted: boolean;
    }
  | {
      type: 'tasks-op-result';
      requestId: string;
      outcome: 'drained';
    }
  | {
      type: 'tasks-op-result';
      requestId: string;
      outcome: 'error';
      code?: string;
      message: string;
    };

export interface TasksChildRuntimeOptions {
  exported: Record<string, unknown>;
  sandbox: RemoteSandbox;
  location: string;
  projectId: string;
  send(event: FunctionsChildEvent): void;
}

export interface TasksChildRuntimeHost extends TasksTriggerExecutionHost {
  handleHostRequest(request: TasksHostRequest): Promise<TasksChildResult>;
}

interface ProcessAdminTaskDispatcher {
  enqueue(request: {
    queueName: string;
    projectId?: string;
    locationId?: string;
    extensionId?: string;
    data: unknown;
    id?: string;
    scheduleDelaySeconds?: number;
    scheduleTimeIso?: string;
    dispatchDeadlineSeconds?: number;
    headers?: Record<string, string>;
    uri?: string;
  }): Promise<void>;
  delete(request: {
    queueName: string;
    projectId?: string;
    locationId?: string;
    extensionId?: string;
    id: string;
  }): Promise<void>;
}

async function sandboxNow(sandbox: RemoteSandbox): Promise<number> {
  try {
    const read = (await sandbox.channel.op({ method: 'sandbox.clock' })) as { now: number };
    return read.now;
  } catch (err: unknown) {
    if (err instanceof Error) {
      return Date.now();
    }
    return Date.now();
  }
}

function attemptChildEvent(
  attemptResult: TaskAttemptResult,
  exportName: string,
  taskId: string,
  retryCount: number,
  executionCount: number,
  scheduledTime: string,
  startedAt: number,
  durationMs: number,
  retryConfig: Record<string, number>,
): FunctionsChildEvent {
  const ref = `queues/${exportName}/tasks/${taskId}`;
  const params: Record<string, string> = {
    queueName: exportName,
    taskId,
    retryCount: String(retryCount),
    executionCount: String(executionCount),
    scheduledTime,
  };
  if (attemptResult.status === 'fulfilled') {
    const fulfilled: FunctionsChildEvent = {
      type: 'execution',
      exportName,
      ref,
      params,
      status: 'fulfilled',
      startedAt,
      durationMs,
    };
    if (Object.keys(retryConfig).length > 0) {
      fulfilled.retryConfig = retryConfig;
    }
    return fulfilled;
  }
  const rejected: FunctionsChildEvent = {
    type: 'execution',
    exportName,
    ref,
    params,
    status: 'rejected',
    error: serializeError(attemptResult.error),
    startedAt,
    durationMs,
  };
  if (Object.keys(retryConfig).length > 0) {
    rejected.retryConfig = retryConfig;
  }
  return rejected;
}

function isTasksChildResultMessage(value: unknown): value is TasksChildResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'tasks-op-result' &&
    typeof (value as { requestId?: unknown }).requestId === 'string'
  );
}

/** Start the v2 Cloud Tasks runtime inside the isolated Functions child. */
export function startTasksChildRuntime(options: TasksChildRuntimeOptions): TasksChildRuntimeHost {
  const { exported, sandbox, location, projectId, send } = options;

  const executionHost = startTasksTriggerExecution({
    exported,
    defaultLocation: location,
    projectId,
    now: () => sandboxNow(sandbox),
    onAttempt(attemptResult, trigger, summary) {
      const retryRecord = tasksRetryConfigToRecord(summary.retryConfig);
      send(
        attemptChildEvent(
          attemptResult,
          trigger.exportName,
          summary.taskId,
          summary.retryCount,
          summary.executionCount,
          summary.scheduledTime,
          summary.startedAt,
          summary.durationMs,
          retryRecord,
        ),
      );
    },
  });

  const processDispatcher: ProcessAdminTaskDispatcher = {
    async enqueue(request) {
      const mappedOpts: EnqueueTaskOptions = {};
      if (request.id !== undefined) {
        mappedOpts.id = request.id;
      }
      if (request.scheduleDelaySeconds !== undefined) {
        mappedOpts.scheduleDelaySeconds = request.scheduleDelaySeconds;
      }
      if (request.scheduleTimeIso !== undefined) {
        mappedOpts.scheduleTime = request.scheduleTimeIso;
      }
      if (request.dispatchDeadlineSeconds !== undefined) {
        mappedOpts.dispatchDeadlineSeconds = request.dispatchDeadlineSeconds;
      }
      if (request.headers !== undefined) {
        mappedOpts.headers = request.headers;
      }
      if (request.uri !== undefined) {
        mappedOpts.uri = request.uri;
      }
      if (request.locationId !== undefined) {
        mappedOpts.locationId = request.locationId;
      }
      if (request.projectId !== undefined) {
        mappedOpts.projectId = request.projectId;
      }
      await executionHost.enqueueTask(request.queueName, request.data, mappedOpts);
    },
    async delete(request) {
      const delOpts: { locationId?: string; projectId?: string } = {};
      if (request.locationId !== undefined) {
        delOpts.locationId = request.locationId;
      }
      if (request.projectId !== undefined) {
        delOpts.projectId = request.projectId;
      }
      await executionHost.deleteTask(request.queueName, request.id, delOpts);
    },
  };

  const globalRecord = globalThis as Record<symbol, unknown>;
  globalRecord[PROCESS_TASK_QUEUE_DISPATCHER] = processDispatcher;

  const handleHostRequest = async (request: TasksHostRequest): Promise<TasksChildResult> => {
    try {
      if (request.type === 'enqueue-task') {
        const receipt = await executionHost.enqueueTask(
          request.targetName,
          request.data,
          request.options,
        );
        return {
          type: 'tasks-op-result',
          requestId: request.requestId,
          outcome: 'enqueued',
          receipt,
        };
      }
      if (request.type === 'delete-task') {
        const deleted = await executionHost.deleteTask(
          request.targetName,
          request.taskId,
          request.options,
        );
        return {
          type: 'tasks-op-result',
          requestId: request.requestId,
          outcome: 'deleted',
          deleted,
        };
      }
      const drainOpts: DrainTasksOptions = {};
      if (request.flushDelayed !== undefined) {
        drainOpts.flushDelayed = request.flushDelayed;
      }
      await executionHost.drainTasks(drainOpts);
      return {
        type: 'tasks-op-result',
        requestId: request.requestId,
        outcome: 'drained',
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      let code: string | undefined;
      if (
        typeof err === 'object' &&
        err !== null &&
        typeof (err as { code?: unknown }).code === 'string'
      ) {
        code = (err as { code: string }).code;
      }
      const failure: TasksChildResult = {
        type: 'tasks-op-result',
        requestId: request.requestId,
        outcome: 'error',
        message,
      };
      if (code !== undefined) {
        failure.code = code;
      }
      return failure;
    }
  };

  return {
    triggerCount: executionHost.triggerCount,
    ready: executionHost.ready,
    triggers: executionHost.triggers,
    enqueueTask: (targetName, data, opts) => executionHost.enqueueTask(targetName, data, opts),
    deleteTask: (targetName, taskId, opts) => executionHost.deleteTask(targetName, taskId, opts),
    drainTasks: (opts) => executionHost.drainTasks(opts),
    idle: () => executionHost.idle(),
    close() {
      if (globalRecord[PROCESS_TASK_QUEUE_DISPATCHER] === processDispatcher) {
        delete globalRecord[PROCESS_TASK_QUEUE_DISPATCHER];
      }
      executionHost.close();
    },
    handleHostRequest,
  };
}

function sendTasksIpcRequest(
  child: ChildProcess,
  payload: TasksHostRequest,
): Promise<TasksChildResult> {
  if (child.exitCode !== null || child.signalCode !== null || typeof child.send !== 'function') {
    return Promise.reject(new Error('Functions child IPC channel is not connected'));
  }
  if (child.connected === false) {
    return Promise.reject(new Error('Functions child IPC channel is disconnected'));
  }

  return new Promise<TasksChildResult>((resolveReply, rejectReply) => {
    let settled = false;
    const cleanup = (): void => {
      child.off('message', onMessage);
      child.off('close', onClose);
      child.off('disconnect', onDisconnect);
    };

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectReply(error);
    };

    const onClose = (): void => {
      fail(new Error(`Functions child exited while handling '${payload.type}'`));
    };

    const onDisconnect = (): void => {
      fail(new Error(`Functions child disconnected while handling '${payload.type}'`));
    };

    const onMessage = (raw: unknown): void => {
      if (!isTasksChildResultMessage(raw)) return;
      if (raw.requestId !== payload.requestId) return;
      if (settled) return;
      settled = true;
      cleanup();
      if (raw.outcome === 'error') {
        const err = new Error(raw.message) as Error & { code?: string };
        if (raw.code !== undefined) {
          err.code = raw.code;
        }
        rejectReply(err);
        return;
      }
      resolveReply(raw);
    };

    child.on('message', onMessage);
    child.once('close', onClose);
    child.once('disconnect', onDisconnect);
    child.send(payload, (sendErr) => {
      if (sendErr) {
        fail(sendErr);
      }
    });
  });
}

/** Send an `enqueue-task` IPC request to a running Functions `ChildProcess`. */
export async function sendChildEnqueueTask(
  child: ChildProcess,
  targetName: string,
  data?: unknown,
  options: EnqueueTaskOptions = {},
): Promise<EnqueuedTaskReceipt> {
  const normalizedOptions: EnqueueTaskOptions = { ...options };
  if (normalizedOptions.scheduleTime instanceof Date) {
    const epochMs = normalizedOptions.scheduleTime.getTime();
    if (!Number.isFinite(epochMs)) {
      throw new Error('Invalid scheduleTime Date');
    }
    normalizedOptions.scheduleTime = new Date(epochMs).toISOString();
  }
  const request: EnqueueTaskHostRequest = {
    type: 'enqueue-task',
    requestId: randomUUID(),
    targetName,
    data,
    options: normalizedOptions,
  };
  const reply = await sendTasksIpcRequest(child, request);
  if (reply.outcome !== 'enqueued') {
    throw new Error(`Unexpected tasks IPC outcome '${reply.outcome}'`);
  }
  return reply.receipt;
}

/** Send a `delete-task` IPC request to a running Functions `ChildProcess`. */
export async function sendChildDeleteTask(
  child: ChildProcess,
  targetName: string,
  taskId: string,
  options?: { extensionId?: string; locationId?: string; projectId?: string },
): Promise<boolean> {
  const request: DeleteTaskHostRequest = {
    type: 'delete-task',
    requestId: randomUUID(),
    targetName,
    taskId,
  };
  if (options !== undefined) {
    request.options = options;
  }
  const reply = await sendTasksIpcRequest(child, request);
  if (reply.outcome !== 'deleted') {
    throw new Error(`Unexpected tasks IPC outcome '${reply.outcome}'`);
  }
  return reply.deleted;
}

/** Send a `drain-tasks` IPC request to a running Functions `ChildProcess`. */
export async function sendChildDrainTasks(
  child: ChildProcess,
  options: DrainTasksOptions = {},
): Promise<void> {
  const request: DrainTasksHostRequest = {
    type: 'drain-tasks',
    requestId: randomUUID(),
  };
  if (options.flushDelayed !== undefined) {
    request.flushDelayed = options.flushDelayed;
  }
  const reply = await sendTasksIpcRequest(child, request);
  if (reply.outcome !== 'drained') {
    throw new Error(`Unexpected tasks IPC outcome '${reply.outcome}'`);
  }
}

/** Record child-emitted task queue execution events into `sandbox` on the host. */
export function recordChildTaskExecutionEvent(
  sandbox: LocalSandbox | undefined,
  event: FunctionsChildEvent,
): void {
  if (sandbox === undefined || event.type !== 'execution') return;
  if (typeof event.params.queueName !== 'string') return;
  const outcome: FunctionExecutionOutcome = {
    trigger: event.exportName,
    ref: event.ref,
    params: event.params,
    startedAt: event.startedAt ?? Date.now(),
    durationMs: event.durationMs ?? 0,
    status: event.status,
  };
  if (event.status === 'rejected') {
    outcome.error = event.error.message;
  }
  if (event.retryConfig !== undefined) {
    outcome.retryConfig = event.retryConfig;
  }
  recordFunctionExecution(sandbox, outcome);
}

/**
 * Attach a `LocalSandbox` task-queue dispatcher that forwards host-side
 * `pyric-admin/functions` `taskQueue()` calls over IPC to the active child.
 */
export function attachDevelopmentRuntimeSandboxTaskBridge(
  sandbox: LocalSandbox | undefined,
  getActiveChild: () => ChildProcess | null,
  isClosed: () => boolean,
): (() => void) | undefined {
  if (sandbox === undefined) return undefined;
  const requireChild = (): ChildProcess => {
    if (isClosed()) {
      const err = new Error('Functions runtime is closed') as Error & { code: string };
      err.code = 'functions/aborted';
      throw err;
    }
    const active = getActiveChild();
    if (active === null) {
      const err = new Error('Functions runtime has no active child process') as Error & {
        code: string;
      };
      err.code = 'functions/failed-precondition';
      throw err;
    }
    return active;
  };

  return attachSandboxTaskQueueDispatcher(sandbox, {
    async enqueue(request) {
      const child = requireChild();
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
      await sendChildEnqueueTask(child, request.queueName, request.data, opts);
    },
    async delete(request) {
      const child = requireChild();
      const delOpts: { locationId?: string; projectId?: string } = {};
      if (request.locationId !== undefined) delOpts.locationId = request.locationId;
      if (request.projectId !== undefined) delOpts.projectId = request.projectId;
      await sendChildDeleteTask(child, request.queueName, request.id, delOpts);
    },
  });
}
