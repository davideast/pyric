/**
 * `ScheduledEvent` encoder and handler runner for `firebase-functions/v2/scheduler`
 * (`7.2.5`), matching `lib/v2/providers/scheduler.js` (`X-CloudScheduler-JobName`,
 * `X-CloudScheduler-ScheduleTime`, `onInit()`, and v1-compat `event.context`).
 */
import type { DiscoveredSchedulerTrigger } from './discovery.js';

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export interface ScheduledEventPayload {
  jobName?: string;
  scheduleTime: string;
}

export interface SchedulerEventOptions {
  scheduleTime: string;
  jobName?: string;
  projectId?: string;
}

export type SchedulerExecutionResult =
  | { status: 'fulfilled'; event: ScheduledEventPayload; result: unknown }
  | { status: 'rejected'; event: ScheduledEventPayload; error: unknown };

interface MockSchedulerRequest {
  headers: Record<string, string>;
  header(name: string): string | undefined;
  get(name: string): string | undefined;
}

interface MockSchedulerResponse {
  statusCode: number;
  body: unknown;
  status(code: number): MockSchedulerResponse;
  send(payload?: unknown): MockSchedulerResponse;
  end(payload?: unknown): MockSchedulerResponse;
  json(payload?: unknown): MockSchedulerResponse;
}

/** Cloud Scheduler job identifier matching `firebase-schedule-<exportName>-<location>`. */
export function defaultSchedulerJobName(exportName: string, location: string): string {
  return `firebase-schedule-${exportName}-${location}`;
}

/**
 * Normalize a caller-provided `scheduleTime` (`string | Date | number`) or
 * fallback epoch instant into an RFC3339 / ISO-8601 UTC `"Z"` string.
 */
export function normalizeScheduleTime(
  scheduleTime: string | Date | number | undefined,
  fallbackEpochMs: number,
): string {
  if (scheduleTime === undefined) {
    return new Date(fallbackEpochMs).toISOString();
  }
  if (scheduleTime instanceof Date) {
    const epochMs = scheduleTime.getTime();
    if (!Number.isFinite(epochMs)) {
      throw new Error('Invalid scheduleTime Date');
    }
    return new Date(epochMs).toISOString();
  }
  if (typeof scheduleTime === 'number') {
    if (!Number.isFinite(scheduleTime)) {
      throw new Error('Invalid scheduleTime epoch milliseconds');
    }
    return new Date(scheduleTime).toISOString();
  }
  if (typeof scheduleTime === 'string') {
    const trimmed = scheduleTime.trim();
    if (!ISO_TIMESTAMP_PATTERN.test(trimmed)) {
      throw new Error(
        `Invalid scheduleTime '${scheduleTime}': expected RFC3339 / ISO-8601 timestamp`,
      );
    }
    const parsedMs = Date.parse(trimmed);
    if (!Number.isFinite(parsedMs)) {
      throw new Error(
        `Invalid scheduleTime '${scheduleTime}': calendar timestamp out of range`,
      );
    }
    return new Date(parsedMs).toISOString();
  }
  throw new Error('Unsupported scheduleTime value');
}

/**
 * Construct an upstream-faithful `ScheduledEvent` (`jobName`, `scheduleTime`)
 * with the non-enumerable `context` getter attached by `scheduler.js`.
 */
export function buildScheduledEvent(options: SchedulerEventOptions): ScheduledEventPayload {
  const effectiveProject = options.projectId ?? process.env.GCLOUD_PROJECT ?? 'demo-project';
  let normalizedJobName: string | undefined;
  if (typeof options.jobName === 'string' && options.jobName.length > 0) {
    normalizedJobName = options.jobName;
  }

  const event: ScheduledEventPayload = {
    jobName: normalizedJobName,
    scheduleTime: options.scheduleTime,
  };

  const contextJobName = normalizedJobName ?? 'unknown-job';
  const v1Context = {
    eventId: contextJobName,
    timestamp: options.scheduleTime,
    eventType: 'google.pubsub.topic.publish',
    resource: {
      service: 'pubsub.googleapis.com',
      name: `projects/${effectiveProject}/topics/${contextJobName}`,
    },
    params: {},
  };

  Object.defineProperty(event, 'context', {
    get: () => v1Context,
    enumerable: false,
    configurable: true,
  });

  return event;
}

function createMockRequest(options: SchedulerEventOptions): MockSchedulerRequest {
  const headers: Record<string, string> = {
    'x-cloudscheduler-scheduletime': options.scheduleTime,
  };
  if (typeof options.jobName === 'string' && options.jobName.length > 0) {
    headers['x-cloudscheduler-jobname'] = options.jobName;
  }
  const lookupHeader = (name: string): string | undefined => headers[name.toLowerCase()];
  return {
    headers,
    header: lookupHeader,
    get: lookupHeader,
  };
}

function createMockResponse(): MockSchedulerResponse {
  const response: MockSchedulerResponse = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      response.statusCode = code;
      return response;
    },
    send(payload?: unknown) {
      if (payload !== undefined) {
        response.body = payload;
      }
      return response;
    },
    end(payload?: unknown) {
      if (payload !== undefined) {
        response.body = payload;
      }
      return response;
    },
    json(payload?: unknown) {
      response.body = payload;
      return response;
    },
  };
  return response;
}

/**
 * Invoke an `onSchedule` endpoint. Real `firebase-functions/v2/scheduler`
 * exports wrap an Express `(req, res)` handler (exposing `.run = handler`)
 * that executes `onInit()` and catches handler throws into `res.status(500)`.
 */
export async function executeSchedulerTrigger(
  trigger: DiscoveredSchedulerTrigger,
  options: SchedulerEventOptions,
): Promise<SchedulerExecutionResult> {
  const event = buildScheduledEvent(options);
  const isExpressWrappedScheduleFunction = typeof trigger.callable.run === 'function';

  if (!isExpressWrappedScheduleFunction) {
    try {
      const result = await trigger.callable(event);
      return { status: 'fulfilled', event, result };
    } catch (error) {
      return { status: 'rejected', event, error };
    }
  }

  const req = createMockRequest(options);
  const res = createMockResponse();
  try {
    await trigger.callable(req, res);
  } catch (error) {
    return { status: 'rejected', event, error };
  }

  if (res.statusCode >= 400) {
    let detail = `Scheduled function ${trigger.exportName} failed with HTTP status ${res.statusCode}`;
    if (typeof res.body === 'string' && res.body.length > 0) {
      detail = `${detail}: ${res.body}`;
    }
    return {
      status: 'rejected',
      event,
      error: new Error(detail),
    };
  }

  return {
    status: 'fulfilled',
    event,
    result: res.body,
  };
}
