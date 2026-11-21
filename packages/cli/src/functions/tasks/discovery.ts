/**
 * Discovery and queue-name resolution for `firebase-functions/v2/tasks`
 * (`onTaskDispatched`) endpoints (`__endpoint.taskQueueTrigger`).
 */
import { listFirebaseEndpoints, type FirebaseEndpoint } from '../endpoints.js';
import { DEFAULT_REGION } from '../http/discovery.js';
import type { FunctionsTriggerFamily } from '../unsupported.js';
import {
  isResetValueObject,
  parseTaskEndpointRegions,
  parseTaskInvokerField,
  parseTaskTimeoutSeconds,
  validateTasksRateLimits,
  validateTasksRetryConfig,
  type TasksRateLimits,
  type TasksRetryConfig,
} from './options-validation.js';

export {
  validateTasksRateLimits,
  validateTasksRetryConfig,
  type TasksRateLimits,
  type TasksRetryConfig,
};

type TaskQueueTriggerCallable = ((...args: unknown[]) => unknown) & {
  run?: (request: unknown) => unknown;
};

export interface DiscoveredTaskTrigger {
  exportName: string;
  retryConfig: TasksRetryConfig;
  rateLimits: TasksRateLimits;
  retry?: boolean;
  invoker?: string[];
  region: string;
  regions: string[];
  location?: string;
  timeoutSeconds?: number;
  callable: TaskQueueTriggerCallable;
}

interface UnsupportedTaskTrigger {
  exportName: string;
  eventType: string;
}

export interface TasksTriggerInspection {
  triggers: DiscoveredTaskTrigger[];
  unsupported: UnsupportedTaskTrigger[];
}

export interface InspectTasksTriggersOptions {
  defaultRegion?: string;
}

export interface ResolvedQueueSelector {
  queueName: string;
  locationId?: string;
  projectId?: string;
}

interface RawTaskQueueTriggerManifest {
  retryConfig?: unknown;
  rateLimits?: unknown;
  invoker?: unknown;
}

function isTaskQueueEndpoint(endpoint: FirebaseEndpoint): boolean {
  return typeof endpoint.taskQueueTrigger === 'object' && endpoint.taskQueueTrigger !== null;
}

/**
 * Inspect exported functions for `firebase-functions/v2/tasks` (`onTaskDispatched`)
 * triggers, classifying omitted, v1, dynamic-expression, or invalid-option exports.
 */
export function inspectTasksTriggers(
  exported: Record<string, unknown>,
  options: InspectTasksTriggersOptions = {},
): TasksTriggerInspection {
  const defaultRegion = options.defaultRegion ?? DEFAULT_REGION;
  const triggers: DiscoveredTaskTrigger[] = [];
  const unsupported: UnsupportedTaskTrigger[] = [];

  for (const { exportName, callable } of listFirebaseEndpoints<TaskQueueTriggerCallable>(
    exported,
  )) {
    const endpoint = callable.__endpoint;
    if (!endpoint || !isTaskQueueEndpoint(endpoint)) continue;

    if (endpoint.platform === 'gcfv1') {
      unsupported.push({
        exportName,
        eventType: 'task-queue (v1 taskQueue is not supported)',
      });
      continue;
    }

    if (endpoint.omit === true) {
      unsupported.push({
        exportName,
        eventType: 'task-queue (omitted from emulation)',
      });
      continue;
    }
    if (
      endpoint.omit !== undefined &&
      endpoint.omit !== false &&
      !isResetValueObject(endpoint.omit)
    ) {
      unsupported.push({
        exportName,
        eventType: 'task-queue (unsupported dynamic omit option)',
      });
      continue;
    }

    const manifest = endpoint.taskQueueTrigger as RawTaskQueueTriggerManifest;
    const retryCheck = validateTasksRetryConfig(manifest.retryConfig);
    if (!retryCheck.ok) {
      let eventType = `task-queue (invalid retryConfig: ${retryCheck.reason})`;
      if (retryCheck.kind === 'dynamic') {
        eventType = 'task-queue (unsupported dynamic retryConfig option)';
      }
      unsupported.push({ exportName, eventType });
      continue;
    }

    const rateLimitsCheck = validateTasksRateLimits(manifest.rateLimits);
    if (!rateLimitsCheck.ok) {
      let eventType = `task-queue (invalid rateLimits: ${rateLimitsCheck.reason})`;
      if (rateLimitsCheck.kind === 'dynamic') {
        eventType = 'task-queue (unsupported dynamic rateLimits option)';
      }
      unsupported.push({ exportName, eventType });
      continue;
    }

    const invokerCheck = parseTaskInvokerField(manifest.invoker);
    if (!invokerCheck.ok) {
      let eventType = 'task-queue (invalid invoker option)';
      if (invokerCheck.kind === 'dynamic') {
        eventType = 'task-queue (unsupported dynamic invoker option)';
      }
      unsupported.push({ exportName, eventType });
      continue;
    }

    const parsedRegions = parseTaskEndpointRegions(endpoint.region, defaultRegion);
    if (!parsedRegions.ok) {
      unsupported.push({
        exportName,
        eventType: 'task-queue (unsupported dynamic region option)',
      });
      continue;
    }

    const parsedTimeout = parseTaskTimeoutSeconds(endpoint.timeoutSeconds);
    if (!parsedTimeout.ok) {
      let eventType = 'task-queue (invalid timeoutSeconds option)';
      if (parsedTimeout.kind === 'dynamic') {
        eventType = 'task-queue (unsupported dynamic timeoutSeconds option)';
      }
      unsupported.push({ exportName, eventType });
      continue;
    }

    const endpointRecord = endpoint as Record<string, unknown>;
    const primaryRegion = parsedRegions.regions[0] ?? defaultRegion;
    const discovered: DiscoveredTaskTrigger = {
      exportName,
      retryConfig: retryCheck.retryConfig,
      rateLimits: rateLimitsCheck.rateLimits,
      region: primaryRegion,
      regions: parsedRegions.regions,
      callable,
    };
    if (typeof endpointRecord.retry === 'boolean') {
      discovered.retry = endpointRecord.retry;
    }
    if (invokerCheck.invoker !== undefined) {
      discovered.invoker = invokerCheck.invoker;
    }
    if (parsedRegions.location !== undefined) {
      discovered.location = parsedRegions.location;
    }
    if (parsedTimeout.timeoutSeconds !== undefined) {
      discovered.timeoutSeconds = parsedTimeout.timeoutSeconds;
    }
    triggers.push(discovered);
  }

  return { triggers, unsupported };
}

/** Discover active v2 `onTaskDispatched` triggers ready for execution. */
export function discoverTasksTriggers(
  exported: Record<string, unknown>,
  options: InspectTasksTriggersOptions = {},
): DiscoveredTaskTrigger[] {
  return inspectTasksTriggers(exported, options).triggers;
}

/**
 * Parse a bare function name (`sendEmail`, `group.worker`, `ext-id-fn`) or
 * resource path (`locations/{loc}/functions/{name}`,
 * `projects/{proj}/locations/{loc}/functions/{name}`) into a queue selector.
 */
export function parseQueueTargetName(
  rawTarget: string,
  extensionId?: string,
): ResolvedQueueSelector {
  if (typeof rawTarget !== 'string' || rawTarget.trim().length === 0) {
    throw new Error('Task queue function name must be a non-empty string');
  }

  let projectId: string | undefined;
  let locationId: string | undefined;
  let baseName: string;

  if (!rawTarget.includes('/')) {
    baseName = rawTarget.replace(/\./g, '-');
  } else {
    const parts = rawTarget.split('/');
    if (
      parts.length === 4 &&
      parts[0] === 'locations' &&
      parts[2] === 'functions' &&
      (parts[1] ?? '').length > 0 &&
      (parts[3] ?? '').length > 0
    ) {
      locationId = parts[1];
      baseName = (parts[3] ?? '').replace(/\./g, '-');
    } else if (
      parts.length === 6 &&
      parts[0] === 'projects' &&
      parts[2] === 'locations' &&
      parts[4] === 'functions' &&
      (parts[1] ?? '').length > 0 &&
      (parts[3] ?? '').length > 0 &&
      (parts[5] ?? '').length > 0
    ) {
      projectId = parts[1];
      locationId = parts[3];
      baseName = (parts[5] ?? '').replace(/\./g, '-');
    } else {
      throw new Error(
        `Invalid task queue target '${rawTarget}': expected function name or locations/{loc}/functions/{name}`,
      );
    }
  }

  if (typeof extensionId === 'string' && extensionId.length > 0) {
    const prefix = `ext-${extensionId}-`;
    if (!baseName.startsWith(prefix)) {
      baseName = `${prefix}${baseName}`;
    }
  }

  const selector: ResolvedQueueSelector = { queueName: baseName };
  if (locationId !== undefined) selector.locationId = locationId;
  if (projectId !== undefined) selector.projectId = projectId;
  return selector;
}

/** Match a parsed queue selector against discovered `onTaskDispatched` triggers. */
export function resolveDiscoveredTaskTrigger(
  triggers: readonly DiscoveredTaskTrigger[],
  selector: ResolvedQueueSelector,
  configuredProjectId?: string,
): DiscoveredTaskTrigger | undefined {
  if (
    selector.projectId !== undefined &&
    configuredProjectId !== undefined &&
    selector.projectId !== configuredProjectId
  ) {
    return undefined;
  }
  for (const trigger of triggers) {
    if (trigger.exportName !== selector.queueName) continue;
    if (selector.locationId !== undefined && !trigger.regions.includes(selector.locationId)) {
      continue;
    }
    return trigger;
  }
  return undefined;
}

/** The v2 Cloud Tasks (`onTaskDispatched`) trigger family. */
export const tasksTriggersFamily: FunctionsTriggerFamily = {
  claims: isTaskQueueEndpoint,
  unsupported: (exported: Record<string, unknown>) => inspectTasksTriggers(exported).unsupported,
};
