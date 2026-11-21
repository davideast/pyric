/**
 * The v2 Cloud Scheduler (`onSchedule`) trigger family inside the isolated
 * Functions child: resolves deterministic sandbox timestamps, executes named
 * scheduled handlers on demand over IPC, and reports execution events to host.
 */
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { RemoteSandbox } from '../../remote/index.js';
import {
  isChildMessage,
  serializeError,
  type FunctionsChildEvent,
  type TriggerScheduledChildResult,
  type TriggerScheduledHostRequest,
} from '../child-protocol.js';
import type { SchedulerExecutionResult } from './event.js';
import { normalizeScheduleTime } from './event.js';
import {
  retryConfigToRecord,
  startSchedulerTriggerExecution,
  type ScheduledTriggerInvocationResult,
  type SchedulerTriggerExecutionHost,
  type TriggerScheduledOptions,
} from './execution.js';

export interface SchedulerChildRuntimeOptions {
  exported: Record<string, unknown>;
  sandbox: RemoteSandbox;
  location: string;
  projectId: string;
  send(event: FunctionsChildEvent): void;
}

export interface SchedulerChildRuntimeHost extends SchedulerTriggerExecutionHost {
  handleHostTriggerRequest(
    request: TriggerScheduledHostRequest,
  ): Promise<TriggerScheduledChildResult>;
}

async function sandboxNow(sandbox: RemoteSandbox): Promise<number> {
  const read = (await sandbox.channel.op({ method: 'sandbox.clock' })) as { now: number };
  return read.now;
}

function isJsonSerializableValue(value: unknown): boolean {
  if (value === undefined) return false;
  if (value === null) return true;
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return true;
  if (kind === 'number') return Number.isFinite(value);
  if (kind === 'function' || kind === 'symbol' || kind === 'bigint') return false;
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

function executionChildEvent(
  result: SchedulerExecutionResult,
  exportName: string,
  ref: string,
  schedule: string,
  scheduleTime: string,
): FunctionsChildEvent {
  const params: Record<string, string> = {
    schedule,
    scheduleTime,
  };
  if (result.status === 'fulfilled') {
    return {
      type: 'execution',
      exportName,
      ref,
      params,
      status: 'fulfilled',
    };
  }
  return {
    type: 'execution',
    exportName,
    ref,
    params,
    status: 'rejected',
    error: serializeError(result.error),
  };
}

/** Start the v2 Scheduler runtime inside the isolated Functions child. */
export function startSchedulerChildRuntime(
  options: SchedulerChildRuntimeOptions,
): SchedulerChildRuntimeHost {
  const { exported, sandbox, location, projectId, send } = options;
  const lastErrors = new Map<string, unknown>();

  const executionHost = startSchedulerTriggerExecution({
    exported,
    defaultLocation: location,
    projectId,
    now: () => sandboxNow(sandbox),
    onExecution(result, trigger, invocation) {
      if (result.status === 'rejected') {
        lastErrors.set(trigger.exportName, result.error);
      } else {
        lastErrors.delete(trigger.exportName);
      }
      const ref = invocation.jobName ?? `schedule/${trigger.exportName}`;
      send(
        executionChildEvent(
          result,
          trigger.exportName,
          ref,
          trigger.schedule,
          invocation.scheduleTime,
        ),
      );
    },
  });

  const activeNames = new Set(executionHost.triggers.map((trigger) => trigger.exportName));

  const handleHostTriggerRequest = async (
    request: TriggerScheduledHostRequest,
  ): Promise<TriggerScheduledChildResult> => {
    if (!activeNames.has(request.exportName)) {
      return {
        type: 'trigger-scheduled-result',
        requestId: request.requestId,
        outcome: 'not-found',
        exportName: request.exportName,
      };
    }

    const invokeOptions: TriggerScheduledOptions = {};
    if (request.scheduleTime !== undefined) {
      invokeOptions.scheduleTime = request.scheduleTime;
    }
    if (request.hasJobNameOverride === true) {
      invokeOptions.jobName = request.jobName;
    }

    try {
      const summary = await executionHost.triggerScheduled(request.exportName, invokeOptions);
      const retryConfig = retryConfigToRecord(summary.retryConfig);
      if (summary.status === 'fulfilled') {
        const fulfilled: TriggerScheduledChildResult = {
          type: 'trigger-scheduled-result',
          requestId: request.requestId,
          outcome: 'fulfilled',
          exportName: summary.exportName,
          scheduleTime: summary.scheduleTime,
          startedAt: summary.startedAt,
          durationMs: summary.durationMs,
          retryConfig,
        };
        if (summary.jobName !== undefined) {
          fulfilled.jobName = summary.jobName;
        }
        if (isJsonSerializableValue(summary.result)) {
          fulfilled.result = summary.result;
        }
        return fulfilled;
      }

      const rawError = lastErrors.get(summary.exportName) ?? new Error(summary.error ?? 'Error');
      const rejected: TriggerScheduledChildResult = {
        type: 'trigger-scheduled-result',
        requestId: request.requestId,
        outcome: 'rejected',
        exportName: summary.exportName,
        scheduleTime: summary.scheduleTime,
        startedAt: summary.startedAt,
        durationMs: summary.durationMs,
        retryConfig,
        error: serializeError(rawError),
      };
      if (summary.jobName !== undefined) {
        rejected.jobName = summary.jobName;
      }
      return rejected;
    } catch (error) {
      return {
        type: 'trigger-scheduled-result',
        requestId: request.requestId,
        outcome: 'invalid-argument',
        exportName: request.exportName,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };

  return {
    triggerCount: executionHost.triggerCount,
    ready: executionHost.ready,
    triggers: executionHost.triggers,
    triggerScheduled: (exportName, invokeOptions) =>
      executionHost.triggerScheduled(exportName, invokeOptions),
    idle: () => executionHost.idle(),
    close: () => executionHost.close(),
    handleHostTriggerRequest,
  };
}

/**
 * Send a `trigger-scheduled` IPC request to a running Functions `ChildProcess`
 * and await its `TriggerScheduledChildResult` reply.
 */
export function sendChildTriggerScheduled(
  child: ChildProcess,
  exportName: string,
  options: TriggerScheduledOptions = {},
): Promise<ScheduledTriggerInvocationResult> {
  if (child.exitCode !== null || child.signalCode !== null || typeof child.send !== 'function') {
    return Promise.reject(new Error('Functions child IPC channel is not connected'));
  }
  if (child.connected === false) {
    return Promise.reject(new Error('Functions child IPC channel is disconnected'));
  }

  let normalizedScheduleTime: string | undefined;
  if (options.scheduleTime !== undefined) {
    try {
      normalizedScheduleTime = normalizeScheduleTime(options.scheduleTime, Date.now());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  const requestId = randomUUID();
  const payload: TriggerScheduledHostRequest = {
    type: 'trigger-scheduled',
    requestId,
    exportName,
  };
  if (normalizedScheduleTime !== undefined) {
    payload.scheduleTime = normalizedScheduleTime;
  }
  if (Object.hasOwn(options, 'jobName')) {
    payload.hasJobNameOverride = true;
    if (options.jobName !== undefined) {
      payload.jobName = options.jobName;
    }
  }

  return new Promise<ScheduledTriggerInvocationResult>((resolveReply, rejectReply) => {
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
      fail(new Error(`Functions child exited while running scheduled trigger '${exportName}'`));
    };

    const onDisconnect = (): void => {
      fail(
        new Error(`Functions child disconnected while running scheduled trigger '${exportName}'`),
      );
    };

    const onMessage = (raw: unknown): void => {
      if (!isChildMessage(raw)) return;
      if (raw.type !== 'trigger-scheduled-result') return;
      if (raw.requestId !== requestId) return;
      if (settled) return;
      settled = true;
      cleanup();

      if (raw.outcome === 'not-found') {
        rejectReply(
          new Error(`Scheduled function '${raw.exportName}' is not an active onSchedule export`),
        );
        return;
      }
      if (raw.outcome === 'invalid-argument') {
        rejectReply(new Error(raw.message));
        return;
      }

      const result: ScheduledTriggerInvocationResult = {
        status: raw.outcome,
        exportName: raw.exportName,
        scheduleTime: raw.scheduleTime,
        startedAt: raw.startedAt,
        durationMs: raw.durationMs,
        retryConfig: { ...raw.retryConfig },
      };
      if (raw.jobName !== undefined) {
        result.jobName = raw.jobName;
      }
      if (raw.outcome === 'fulfilled') {
        if (raw.result !== undefined) {
          result.result = raw.result;
        }
      } else {
        result.error = raw.error.message;
      }
      resolveReply(result);
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
