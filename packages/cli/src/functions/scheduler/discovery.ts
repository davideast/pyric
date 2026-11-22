/**
 * Discovery and manifest validation for `firebase-functions/v2/scheduler`
 * (`onSchedule`) endpoints (`__endpoint.scheduleTrigger`).
 */
import {
  classifyEndpointOmit,
  isResetValueObject,
  listFirebaseEndpoints,
  type FirebaseEndpoint,
} from '../endpoints.js';
import { DEFAULT_REGION } from '../http/discovery.js';
import type { FunctionsTriggerFamily } from '../unsupported.js';
import {
  parseScheduleExpression,
  type ParsedScheduleExpression,
} from './schedule-expression.js';

export interface SchedulerRetryConfig {
  retryCount?: number;
  maxRetrySeconds?: number;
  minBackoffSeconds?: number;
  maxBackoffSeconds?: number;
  maxDoublings?: number;
}

type SchedulerTriggerCallable = ((...args: unknown[]) => unknown) & {
  run?: (event: unknown) => unknown;
};

export interface DiscoveredSchedulerTrigger {
  exportName: string;
  schedule: string;
  parsedSchedule?: ParsedScheduleExpression;
  timeZone?: string;
  retryConfig: SchedulerRetryConfig;
  region: string;
  regions: string[];
  location?: string;
  timeoutSeconds?: number;
  callable: SchedulerTriggerCallable;
}

interface UnsupportedSchedulerTrigger {
  exportName: string;
  eventType: string;
}

export interface SchedulerTriggerInspection {
  triggers: DiscoveredSchedulerTrigger[];
  unsupported: UnsupportedSchedulerTrigger[];
}

export interface InspectSchedulerTriggersOptions {
  defaultRegion?: string;
  validateSchedule?: boolean;
}

interface RawScheduleTriggerManifest {
  schedule?: unknown;
  timeZone?: unknown;
  retryConfig?: unknown;
}

export type RetryConfigValidationResult =
  | { ok: true; retryConfig: SchedulerRetryConfig }
  | { ok: false; kind: 'dynamic' | 'invalid'; reason: string };

export function isScheduleEndpoint(endpoint: FirebaseEndpoint): boolean {
  return typeof endpoint.scheduleTrigger === 'object' && endpoint.scheduleTrigger !== null;
}

function isSupportedTimeZone(timeZone: string): boolean {
  if (timeZone.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function parseEndpointRegions(
  region: unknown,
  defaultRegion: string,
): { ok: true; regions: string[]; location?: string } | { ok: false } {
  if (region === undefined || region === null || isResetValueObject(region)) {
    return { ok: true, regions: [defaultRegion] };
  }
  if (typeof region === 'string') {
    if (region.length === 0) return { ok: false };
    return { ok: true, regions: [region], location: region };
  }
  if (Array.isArray(region)) {
    if (region.length === 0) {
      return { ok: true, regions: [defaultRegion] };
    }
    const allStrings = region.every((item) => typeof item === 'string' && item.length > 0);
    if (!allStrings) return { ok: false };
    const regions = region as string[];
    const first = regions[0];
    if (typeof first === 'string') {
      return { ok: true, regions, location: first };
    }
    return { ok: true, regions: [defaultRegion] };
  }
  return { ok: false };
}

function parseTimeoutSeconds(
  rawTimeout: unknown,
): { ok: true; timeoutSeconds?: number } | { ok: false; kind: 'dynamic' | 'invalid' } {
  if (rawTimeout === undefined || rawTimeout === null || isResetValueObject(rawTimeout)) {
    return { ok: true };
  }
  if (typeof rawTimeout === 'object') {
    return { ok: false, kind: 'dynamic' };
  }
  if (typeof rawTimeout !== 'number' || !Number.isFinite(rawTimeout) || rawTimeout <= 0) {
    return { ok: false, kind: 'invalid' };
  }
  return { ok: true, timeoutSeconds: rawTimeout };
}

function parseNonNegativeIntegerField(
  rawValue: unknown,
  fieldName: string,
): { ok: true; value?: number } | { ok: false; kind: 'dynamic' | 'invalid'; reason: string } {
  if (rawValue === undefined || rawValue === null || isResetValueObject(rawValue)) {
    return { ok: true };
  }
  if (typeof rawValue === 'object') {
    return { ok: false, kind: 'dynamic', reason: `dynamic ${fieldName}` };
  }
  if (typeof rawValue !== 'number' || !Number.isSafeInteger(rawValue) || rawValue < 0) {
    return {
      ok: false,
      kind: 'invalid',
      reason: `${fieldName} must be a non-negative integer`,
    };
  }
  return { ok: true, value: rawValue };
}

function parseDurationSecondsField(
  rawValue: unknown,
  fieldName: string,
): { ok: true; value?: number } | { ok: false; kind: 'dynamic' | 'invalid'; reason: string } {
  if (rawValue === undefined || rawValue === null || isResetValueObject(rawValue)) {
    return { ok: true };
  }
  if (typeof rawValue === 'object') {
    return { ok: false, kind: 'dynamic', reason: `dynamic ${fieldName}` };
  }
  if (typeof rawValue === 'number') {
    if (!Number.isFinite(rawValue) || rawValue < 0) {
      return {
        ok: false,
        kind: 'invalid',
        reason: `${fieldName} must be a non-negative number`,
      };
    }
    return { ok: true, value: rawValue };
  }
  if (typeof rawValue === 'string') {
    const match = /^(\d+(?:\.\d+)?)s$/.exec(rawValue.trim());
    if (!match) {
      return {
        ok: false,
        kind: 'invalid',
        reason: `${fieldName} duration string '${rawValue}' is invalid`,
      };
    }
    const parsed = Number(match[1]);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return {
        ok: false,
        kind: 'invalid',
        reason: `${fieldName} must be non-negative`,
      };
    }
    return { ok: true, value: parsed };
  }
  return {
    ok: false,
    kind: 'invalid',
    reason: `${fieldName} must be a non-negative number`,
  };
}

/** Validate `scheduleTrigger.retryConfig` against `firebase-functions/v2/scheduler` shapes. */
export function validateSchedulerRetryConfig(rawRetryConfig: unknown): RetryConfigValidationResult {
  if (
    rawRetryConfig === undefined ||
    rawRetryConfig === null ||
    isResetValueObject(rawRetryConfig)
  ) {
    return { ok: true, retryConfig: {} };
  }
  if (typeof rawRetryConfig !== 'object' || Array.isArray(rawRetryConfig)) {
    return {
      ok: false,
      kind: 'invalid',
      reason: 'retryConfig must be an object',
    };
  }

  const record = rawRetryConfig as Record<string, unknown>;
  const retryCount = parseNonNegativeIntegerField(record.retryCount, 'retryCount');
  if (!retryCount.ok) return retryCount;

  const maxDoublings = parseNonNegativeIntegerField(record.maxDoublings, 'maxDoublings');
  if (!maxDoublings.ok) return maxDoublings;

  const maxRetrySeconds = parseDurationSecondsField(record.maxRetrySeconds, 'maxRetrySeconds');
  if (!maxRetrySeconds.ok) return maxRetrySeconds;

  const minBackoffSeconds = parseDurationSecondsField(
    record.minBackoffSeconds,
    'minBackoffSeconds',
  );
  if (!minBackoffSeconds.ok) return minBackoffSeconds;

  const maxBackoffSeconds = parseDurationSecondsField(
    record.maxBackoffSeconds,
    'maxBackoffSeconds',
  );
  if (!maxBackoffSeconds.ok) return maxBackoffSeconds;

  if (
    minBackoffSeconds.value !== undefined &&
    maxBackoffSeconds.value !== undefined &&
    minBackoffSeconds.value > maxBackoffSeconds.value
  ) {
    return {
      ok: false,
      kind: 'invalid',
      reason: 'minBackoffSeconds cannot exceed maxBackoffSeconds',
    };
  }

  const retryConfig: SchedulerRetryConfig = {};
  if (retryCount.value !== undefined) {
    retryConfig.retryCount = retryCount.value;
  }
  if (maxRetrySeconds.value !== undefined) {
    retryConfig.maxRetrySeconds = maxRetrySeconds.value;
  }
  if (minBackoffSeconds.value !== undefined) {
    retryConfig.minBackoffSeconds = minBackoffSeconds.value;
  }
  if (maxBackoffSeconds.value !== undefined) {
    retryConfig.maxBackoffSeconds = maxBackoffSeconds.value;
  }
  if (maxDoublings.value !== undefined) {
    retryConfig.maxDoublings = maxDoublings.value;
  }

  return { ok: true, retryConfig };
}

/**
 * Inspect exported functions for `firebase-functions/v2/scheduler` (`onSchedule`)
 * triggers, classifying omitted, v1, dynamic-expression, or invalid-option exports.
 */
export function inspectSchedulerTriggers(
  exported: Record<string, unknown>,
  options: InspectSchedulerTriggersOptions = {},
): SchedulerTriggerInspection {
  const defaultRegion = options.defaultRegion ?? DEFAULT_REGION;
  const shouldValidateSchedule = options.validateSchedule ?? true;
  const triggers: DiscoveredSchedulerTrigger[] = [];
  const unsupported: UnsupportedSchedulerTrigger[] = [];

  for (const { exportName, callable } of listFirebaseEndpoints<SchedulerTriggerCallable>(exported)) {
    const endpoint = callable.__endpoint;
    if (!endpoint || !isScheduleEndpoint(endpoint)) continue;

    const omitState = classifyEndpointOmit(endpoint.omit);
    if (omitState === 'omitted') {
      unsupported.push({
        exportName,
        eventType: 'schedule (omitted from emulation)',
      });
      continue;
    }
    if (omitState === 'dynamic') {
      unsupported.push({
        exportName,
        eventType: 'schedule (unsupported dynamic omit option)',
      });
      continue;
    }

    if (endpoint.platform === 'gcfv1') {
      unsupported.push({
        exportName,
        eventType: 'schedule (v1 pubsub.schedule is not supported)',
      });
      continue;
    }

    const scheduleManifest = endpoint.scheduleTrigger as RawScheduleTriggerManifest;
    const rawSchedule = scheduleManifest.schedule;
    if (typeof rawSchedule !== 'string') {
      unsupported.push({
        exportName,
        eventType: 'schedule (unsupported dynamic schedule option)',
      });
      continue;
    }

    let parsedSchedule: ParsedScheduleExpression | undefined;
    if (shouldValidateSchedule) {
      const scheduleCheck = parseScheduleExpression(rawSchedule);
      if (!scheduleCheck.ok) {
        unsupported.push({
          exportName,
          eventType: `schedule (invalid schedule: ${scheduleCheck.reason})`,
        });
        continue;
      }
      parsedSchedule = scheduleCheck.parsed;
    }

    const rawTimeZone = scheduleManifest.timeZone;
    let timeZone: string | undefined;
    if (rawTimeZone !== undefined && rawTimeZone !== null && !isResetValueObject(rawTimeZone)) {
      if (typeof rawTimeZone !== 'string') {
        unsupported.push({
          exportName,
          eventType: 'schedule (unsupported dynamic timeZone option)',
        });
        continue;
      }
      if (!isSupportedTimeZone(rawTimeZone)) {
        unsupported.push({
          exportName,
          eventType: `schedule (invalid timeZone: ${rawTimeZone})`,
        });
        continue;
      }
      timeZone = rawTimeZone;
    }

    const retryCheck = validateSchedulerRetryConfig(scheduleManifest.retryConfig);
    if (!retryCheck.ok) {
      if (retryCheck.kind === 'dynamic') {
        unsupported.push({
          exportName,
          eventType: 'schedule (unsupported dynamic retryConfig option)',
        });
      } else {
        unsupported.push({
          exportName,
          eventType: `schedule (invalid retryConfig: ${retryCheck.reason})`,
        });
      }
      continue;
    }

    const parsedRegions = parseEndpointRegions(endpoint.region, defaultRegion);
    if (!parsedRegions.ok) {
      unsupported.push({
        exportName,
        eventType: 'schedule (unsupported dynamic region option)',
      });
      continue;
    }

    const parsedTimeout = parseTimeoutSeconds(endpoint.timeoutSeconds);
    if (!parsedTimeout.ok) {
      if (parsedTimeout.kind === 'dynamic') {
        unsupported.push({
          exportName,
          eventType: 'schedule (unsupported dynamic timeoutSeconds option)',
        });
      } else {
        unsupported.push({
          exportName,
          eventType: 'schedule (invalid timeoutSeconds option)',
        });
      }
      continue;
    }

    const primaryRegion = parsedRegions.regions[0] ?? defaultRegion;
    const discovered: DiscoveredSchedulerTrigger = {
      exportName,
      schedule: rawSchedule.trim(),
      retryConfig: retryCheck.retryConfig,
      region: primaryRegion,
      regions: parsedRegions.regions,
      callable,
    };
    if (parsedSchedule !== undefined) {
      discovered.parsedSchedule = parsedSchedule;
    }
    if (timeZone !== undefined) {
      discovered.timeZone = timeZone;
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

/** Discover active v2 `onSchedule` triggers ready for execution. */
export function discoverSchedulerTriggers(
  exported: Record<string, unknown>,
  options: InspectSchedulerTriggersOptions = {},
): DiscoveredSchedulerTrigger[] {
  return inspectSchedulerTriggers(exported, options).triggers;
}

/** The v2 Cloud Scheduler (`onSchedule`) trigger family. */
export const schedulerTriggersFamily: FunctionsTriggerFamily = {
  claims: isScheduleEndpoint,
  unsupported: (exported: Record<string, unknown>) => inspectSchedulerTriggers(exported).unsupported,
};
