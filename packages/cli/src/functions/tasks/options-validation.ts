/**
 * Manifest option validation helpers for `firebase-functions/v2/tasks`
 * (`onTaskDispatched`): unwraps `RESET_VALUE` sentinels and validates
 * `retryConfig`, `rateLimits`, `invoker`, `region`, and `timeoutSeconds`.
 */
import { isResetValueObject } from '../endpoints.js';

export interface TasksRetryConfig {
  maxAttempts?: number;
  maxRetrySeconds?: number;
  minBackoffSeconds?: number;
  maxBackoffSeconds?: number;
  maxDoublings?: number;
}

export interface TasksRateLimits {
  maxConcurrentDispatches?: number;
  maxDispatchesPerSecond?: number;
}

type TasksRetryValidationResult =
  | { ok: true; retryConfig: TasksRetryConfig }
  | { ok: false; kind: 'dynamic' | 'invalid'; reason: string };

type TasksRateLimitsValidationResult =
  | { ok: true; rateLimits: TasksRateLimits }
  | { ok: false; kind: 'dynamic' | 'invalid'; reason: string };

const MAX_TASK_TIMEOUT_SECONDS = 1800;

export function parseTaskEndpointRegions(
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

export function parseTaskTimeoutSeconds(
  rawTimeout: unknown,
): { ok: true; timeoutSeconds?: number } | { ok: false; kind: 'dynamic' | 'invalid' } {
  if (rawTimeout === undefined || rawTimeout === null || isResetValueObject(rawTimeout)) {
    return { ok: true };
  }
  if (typeof rawTimeout === 'object') {
    return { ok: false, kind: 'dynamic' };
  }
  if (
    typeof rawTimeout !== 'number' ||
    !Number.isFinite(rawTimeout) ||
    rawTimeout <= 0 ||
    rawTimeout > MAX_TASK_TIMEOUT_SECONDS
  ) {
    return { ok: false, kind: 'invalid' };
  }
  return { ok: true, timeoutSeconds: rawTimeout };
}

export function parseTaskInvokerField(
  rawInvoker: unknown,
): { ok: true; invoker?: string[] } | { ok: false; kind: 'dynamic' | 'invalid' } {
  if (rawInvoker === undefined || rawInvoker === null || isResetValueObject(rawInvoker)) {
    return { ok: true };
  }
  if (typeof rawInvoker === 'string') {
    if (rawInvoker.length === 0) return { ok: false, kind: 'invalid' };
    return { ok: true, invoker: [rawInvoker] };
  }
  if (Array.isArray(rawInvoker)) {
    const valid = rawInvoker.every((entry) => typeof entry === 'string' && entry.length > 0);
    if (!valid) return { ok: false, kind: 'invalid' };
    return { ok: true, invoker: [...(rawInvoker as string[])] };
  }
  if (typeof rawInvoker === 'object') {
    return { ok: false, kind: 'dynamic' };
  }
  return { ok: false, kind: 'invalid' };
}

function parseIntegerField(
  rawValue: unknown,
  fieldName: string,
  minAllowed: number,
): { ok: true; value?: number } | { ok: false; kind: 'dynamic' | 'invalid'; reason: string } {
  if (rawValue === undefined || rawValue === null || isResetValueObject(rawValue)) {
    return { ok: true };
  }
  if (typeof rawValue === 'object') {
    return { ok: false, kind: 'dynamic', reason: `dynamic ${fieldName}` };
  }
  if (typeof rawValue !== 'number' || !Number.isSafeInteger(rawValue) || rawValue < minAllowed) {
    return {
      ok: false,
      kind: 'invalid',
      reason: `${fieldName} must be an integer >= ${minAllowed}`,
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
      return { ok: false, kind: 'invalid', reason: `${fieldName} must be a non-negative number` };
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
      return { ok: false, kind: 'invalid', reason: `${fieldName} must be non-negative` };
    }
    return { ok: true, value: parsed };
  }
  return { ok: false, kind: 'invalid', reason: `${fieldName} must be a non-negative number` };
}

/** Validate `taskQueueTrigger.retryConfig` against `firebase-functions/v2/tasks` shapes. */
export function validateTasksRetryConfig(rawRetryConfig: unknown): TasksRetryValidationResult {
  if (
    rawRetryConfig === undefined ||
    rawRetryConfig === null ||
    isResetValueObject(rawRetryConfig)
  ) {
    return { ok: true, retryConfig: {} };
  }
  if (typeof rawRetryConfig !== 'object' || Array.isArray(rawRetryConfig)) {
    return { ok: false, kind: 'invalid', reason: 'retryConfig must be an object' };
  }

  const record = rawRetryConfig as Record<string, unknown>;
  const maxAttempts = parseIntegerField(record.maxAttempts, 'maxAttempts', -1);
  if (!maxAttempts.ok) return maxAttempts;

  const maxDoublings = parseIntegerField(record.maxDoublings, 'maxDoublings', 0);
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

  const retryConfig: TasksRetryConfig = {};
  if (maxAttempts.value !== undefined) retryConfig.maxAttempts = maxAttempts.value;
  if (maxRetrySeconds.value !== undefined) retryConfig.maxRetrySeconds = maxRetrySeconds.value;
  if (minBackoffSeconds.value !== undefined) {
    retryConfig.minBackoffSeconds = minBackoffSeconds.value;
  }
  if (maxBackoffSeconds.value !== undefined) {
    retryConfig.maxBackoffSeconds = maxBackoffSeconds.value;
  }
  if (maxDoublings.value !== undefined) retryConfig.maxDoublings = maxDoublings.value;
  return { ok: true, retryConfig };
}

/** Validate `taskQueueTrigger.rateLimits` against `firebase-functions/v2/tasks` shapes. */
export function validateTasksRateLimits(rawRateLimits: unknown): TasksRateLimitsValidationResult {
  if (rawRateLimits === undefined || rawRateLimits === null || isResetValueObject(rawRateLimits)) {
    return { ok: true, rateLimits: {} };
  }
  if (typeof rawRateLimits !== 'object' || Array.isArray(rawRateLimits)) {
    return { ok: false, kind: 'invalid', reason: 'rateLimits must be an object' };
  }

  const record = rawRateLimits as Record<string, unknown>;
  const maxConcurrentDispatches = parseIntegerField(
    record.maxConcurrentDispatches,
    'maxConcurrentDispatches',
    1,
  );
  if (!maxConcurrentDispatches.ok) return maxConcurrentDispatches;

  let maxDispatchesPerSecond: number | undefined;
  const rawRate = record.maxDispatchesPerSecond;
  if (rawRate !== undefined && rawRate !== null && !isResetValueObject(rawRate)) {
    if (typeof rawRate === 'object') {
      return { ok: false, kind: 'dynamic', reason: 'dynamic maxDispatchesPerSecond' };
    }
    if (typeof rawRate !== 'number' || !Number.isFinite(rawRate) || rawRate <= 0) {
      return {
        ok: false,
        kind: 'invalid',
        reason: 'maxDispatchesPerSecond must be a positive number',
      };
    }
    maxDispatchesPerSecond = rawRate;
  }

  const rateLimits: TasksRateLimits = {};
  if (maxConcurrentDispatches.value !== undefined) {
    rateLimits.maxConcurrentDispatches = maxConcurrentDispatches.value;
  }
  if (maxDispatchesPerSecond !== undefined) {
    rateLimits.maxDispatchesPerSecond = maxDispatchesPerSecond;
  }
  return { ok: true, rateLimits };
}
