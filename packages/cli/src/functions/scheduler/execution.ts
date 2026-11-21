/**
 * Deterministic execution host for discovered `firebase-functions/v2/scheduler`
 * (`onSchedule`) triggers: runs manual/programmatic invocations serially without
 * wall-clock timers and records outcomes in `execution-log.ts`.
 */
import { getClock, type LocalSandbox } from 'pyric/sandbox';
import { emitHandlerFired, emitTriggerDiscovered } from '../events.js';
import {
  recordFunctionExecution,
  type FunctionExecutionRecord,
} from '../execution-log.js';
import { DEFAULT_REGION } from '../http/discovery.js';
import {
  discoverSchedulerTriggers,
  type DiscoveredSchedulerTrigger,
  type SchedulerRetryConfig,
} from './discovery.js';
import {
  defaultSchedulerJobName,
  executeSchedulerTrigger,
  normalizeScheduleTime,
  type SchedulerExecutionResult,
} from './event.js';

export interface TriggerScheduledOptions {
  scheduleTime?: string | Date | number;
  jobName?: string;
}

export interface ScheduledTriggerInvocationResult {
  status: 'fulfilled' | 'rejected';
  exportName: string;
  jobName?: string;
  scheduleTime: string;
  startedAt: number;
  durationMs: number;
  retryConfig: SchedulerRetryConfig;
  result?: unknown;
  error?: string;
  record?: FunctionExecutionRecord;
}

export interface SchedulerTriggerExecutionOptions {
  exported: Record<string, unknown>;
  defaultLocation?: string;
  projectId?: string;
  validateSchedule?: boolean;
  sandbox?: LocalSandbox;
  now?: () => number | Promise<number>;
  onExecution?(
    result: SchedulerExecutionResult,
    trigger: DiscoveredSchedulerTrigger,
    invocation: ScheduledTriggerInvocationResult,
  ): void;
}

export interface SchedulerTriggerExecutionHost {
  readonly triggerCount: number;
  readonly ready: Promise<void>;
  readonly triggers: readonly DiscoveredSchedulerTrigger[];
  triggerScheduled(
    exportName: string,
    options?: TriggerScheduledOptions,
  ): Promise<ScheduledTriggerInvocationResult>;
  idle(): Promise<void>;
  close(): void;
}

export function retryConfigToRecord(
  retryConfig: SchedulerRetryConfig,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (retryConfig.retryCount !== undefined) {
    out.retryCount = retryConfig.retryCount;
  }
  if (retryConfig.maxRetrySeconds !== undefined) {
    out.maxRetrySeconds = retryConfig.maxRetrySeconds;
  }
  if (retryConfig.minBackoffSeconds !== undefined) {
    out.minBackoffSeconds = retryConfig.minBackoffSeconds;
  }
  if (retryConfig.maxBackoffSeconds !== undefined) {
    out.maxBackoffSeconds = retryConfig.maxBackoffSeconds;
  }
  if (retryConfig.maxDoublings !== undefined) {
    out.maxDoublings = retryConfig.maxDoublings;
  }
  return out;
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Start deterministic execution host for discovered `onSchedule` exports. */
export function startSchedulerTriggerExecution(
  options: SchedulerTriggerExecutionOptions,
): SchedulerTriggerExecutionHost {
  const defaultLocation = options.defaultLocation ?? DEFAULT_REGION;
  const discoveryOptions: { defaultRegion: string; validateSchedule?: boolean } = {
    defaultRegion: defaultLocation,
  };
  if (options.validateSchedule !== undefined) {
    discoveryOptions.validateSchedule = options.validateSchedule;
  }
  const triggers = discoverSchedulerTriggers(options.exported, discoveryOptions);
  const triggerByName = new Map<string, DiscoveredSchedulerTrigger>(
    triggers.map((trigger) => [trigger.exportName, trigger]),
  );

  let closed = false;
  let tail: Promise<void> = Promise.resolve();
  const ready = Promise.resolve();

  const readNow = async (): Promise<number> => {
    if (options.now !== undefined) {
      return await options.now();
    }
    if (options.sandbox !== undefined) {
      return getClock(options.sandbox).now();
    }
    return Date.now();
  };

  const triggerScheduled = (
    exportName: string,
    invokeOptions: TriggerScheduledOptions = {},
  ): Promise<ScheduledTriggerInvocationResult> => {
    if (closed) {
      return Promise.reject(new Error('Functions scheduler execution host is closed'));
    }
    const trigger = triggerByName.get(exportName);
    if (trigger === undefined) {
      return Promise.reject(
        new Error(`Scheduled function '${exportName}' is not an active onSchedule export`),
      );
    }

    const run = async (): Promise<ScheduledTriggerInvocationResult> => {
      if (closed) {
        throw new Error('Functions scheduler execution host is closed');
      }
      const startedAt = await readNow();
      const startedWallMs = Date.now();
      const scheduleTime = normalizeScheduleTime(invokeOptions.scheduleTime, startedAt);
      const effectiveLocation = trigger.location ?? defaultLocation;

      let jobName: string | undefined;
      if (Object.hasOwn(invokeOptions, 'jobName')) {
        jobName = invokeOptions.jobName;
      } else {
        jobName = defaultSchedulerJobName(trigger.exportName, effectiveLocation);
      }

      const ref = jobName ?? `schedule/${trigger.exportName}`;
      const params: Record<string, string> = {
        schedule: trigger.schedule,
        scheduleTime,
      };
      if (trigger.timeZone !== undefined) {
        params.timeZone = trigger.timeZone;
      }

      if (options.sandbox !== undefined) {
        emitTriggerDiscovered(options.sandbox, {
          exportName: trigger.exportName,
          reference: ref,
          instance: effectiveLocation,
        });
        emitHandlerFired(options.sandbox, {
          trigger: trigger.exportName,
          ref,
          params,
        });
      }

      const eventOptions: {
        scheduleTime: string;
        jobName?: string;
        projectId?: string;
      } = { scheduleTime };
      if (jobName !== undefined) {
        eventOptions.jobName = jobName;
      }
      if (options.projectId !== undefined) {
        eventOptions.projectId = options.projectId;
      }

      const executionResult = await executeSchedulerTrigger(trigger, eventOptions);
      const durationMs = Math.max(0, Date.now() - startedWallMs);
      const retryRecord = retryConfigToRecord(trigger.retryConfig);

      const summary: ScheduledTriggerInvocationResult = {
        status: executionResult.status,
        exportName: trigger.exportName,
        scheduleTime,
        startedAt,
        durationMs,
        retryConfig: { ...trigger.retryConfig },
      };
      if (jobName !== undefined) {
        summary.jobName = jobName;
      }

      if (executionResult.status === 'fulfilled') {
        if (executionResult.result !== undefined) {
          summary.result = executionResult.result;
        }
      } else {
        summary.error = errorMessageOf(executionResult.error);
      }

      if (options.sandbox !== undefined) {
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
          trigger: trigger.exportName,
          ref,
          params,
          startedAt,
          durationMs,
          status: executionResult.status,
        };
        if (executionResult.status === 'fulfilled') {
          outcome.result = executionResult.result;
        } else {
          outcome.error = summary.error;
        }
        if (Object.keys(retryRecord).length > 0) {
          outcome.retryConfig = retryRecord;
        }
        summary.record = recordFunctionExecution(options.sandbox, outcome);
      }

      options.onExecution?.(executionResult, trigger, summary);
      return summary;
    };

    const scheduledPromise = tail.then(run);
    tail = scheduledPromise.then(
      () => undefined,
      () => undefined,
    );
    return scheduledPromise;
  };

  return {
    triggerCount: triggers.length,
    ready,
    triggers,
    triggerScheduled,
    idle: () => tail,
    close() {
      closed = true;
    },
  };
}
