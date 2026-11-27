/**
 * Manifest option validation helpers for `firebase-functions/v2/tasks`
 * (`onTaskDispatched`): unwraps `RESET_VALUE` sentinels and validates
 * `retryConfig`, `rateLimits`, `invoker`, `region`, and `timeoutSeconds`.
 */
import {
  resolveEndpointRegionsOption,
  resolveInvokerOption,
  resolveTimeoutSecondsOption,
} from '../endpoint-options.js';
import { isResetValueObject } from '../endpoints.js';
import {
  isParamExpression,
  resolveParamExpression,
  type ParamsEnvMap,
} from '../params-resolver.js';

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
  env?: ParamsEnvMap,
): { ok: true; regions: string[]; location?: string } | { ok: false } {
  const resolved = resolveEndpointRegionsOption(region, defaultRegion, env);
  if (!resolved.ok) return { ok: false };
  const result: { ok: true; regions: string[]; location?: string } = {
    ok: true,
    regions: resolved.regions,
  };
  if (resolved.location !== undefined) {
    result.location = resolved.location;
  }
  return result;
}

export function parseTaskTimeoutSeconds(
  rawTimeout: unknown,
  env?: ParamsEnvMap,
): { ok: true; timeoutSeconds?: number } | { ok: false; kind: 'dynamic' | 'invalid' } {
  const resolved = resolveTimeoutSecondsOption(rawTimeout, env, {
    maxSeconds: MAX_TASK_TIMEOUT_SECONDS,
  });
  if (!resolved.ok) return resolved;
  const result: { ok: true; timeoutSeconds?: number } = { ok: true };
  if (resolved.timeoutSeconds !== undefined) {
    result.timeoutSeconds = resolved.timeoutSeconds;
  }
  return result;
}

export function parseTaskInvokerField(
  rawInvoker: unknown,
  env?: ParamsEnvMap,
): { ok: true; invoker?: string[] } | { ok: false; kind: 'dynamic' | 'invalid' } {
  return resolveInvokerOption(rawInvoker, env);
}

function parseIntegerField(
  rawValue: unknown,
  fieldName: string,
  minAllowed: number,
  env: ParamsEnvMap | undefined,
): { ok: true; value?: number } | { ok: false; kind: 'dynamic' | 'invalid'; reason: string } {
  if (rawValue === undefined || rawValue === null || isResetValueObject(rawValue)) {
    return { ok: true };
  }
  let candidate: unknown = rawValue;
  if (isParamExpression(rawValue)) {
    const resolved = resolveParamExpression(rawValue, env);
    if (!resolved.ok) {
      return { ok: false, kind: 'dynamic', reason: `dynamic ${fieldName}` };
    }
    candidate = resolved.value;
    if (candidate === undefined || candidate === null || isResetValueObject(candidate)) {
      return { ok: true };
    }
  } else if (typeof rawValue === 'object') {
    return { ok: false, kind: 'dynamic', reason: `dynamic ${fieldName}` };
  }
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < minAllowed) {
    return {
      ok: false,
      kind: 'invalid',
      reason: `${fieldName} must be an integer >= ${minAllowed}`,
    };
  }
  return { ok: true, value: candidate };
}

function parseDurationSecondsField(
  rawValue: unknown,
  fieldName: string,
  env: ParamsEnvMap | undefined,
): { ok: true; value?: number } | { ok: false; kind: 'dynamic' | 'invalid'; reason: string } {
  if (rawValue === undefined || rawValue === null || isResetValueObject(rawValue)) {
    return { ok: true };
  }
  let candidate: unknown = rawValue;
  let containsSecret = false;
  if (isParamExpression(rawValue)) {
    const resolved = resolveParamExpression(rawValue, env);
    if (!resolved.ok) {
      return { ok: false, kind: 'dynamic', reason: `dynamic ${fieldName}` };
    }
    candidate = resolved.value;
    containsSecret = resolved.containsSecret;
    if (candidate === undefined || candidate === null || isResetValueObject(candidate)) {
      return { ok: true };
    }
  } else if (typeof rawValue === 'object') {
    return { ok: false, kind: 'dynamic', reason: `dynamic ${fieldName}` };
  }
  if (typeof candidate === 'number') {
    if (!Number.isFinite(candidate) || candidate < 0) {
      return { ok: false, kind: 'invalid', reason: `${fieldName} must be a non-negative number` };
    }
    return { ok: true, value: candidate };
  }
  if (typeof candidate === 'string') {
    const match = /^(\d+(?:\.\d+)?)s$/.exec(candidate.trim());
    if (!match) {
      const reason = containsSecret
        ? `${fieldName} duration string is invalid`
        : `${fieldName} duration string '${candidate}' is invalid`;
      return { ok: false, kind: 'invalid', reason };
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
export function validateTasksRetryConfig(
  rawRetryConfig: unknown,
  env?: ParamsEnvMap,
): TasksRetryValidationResult {
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
  const maxAttempts = parseIntegerField(record.maxAttempts, 'maxAttempts', -1, env);
  if (!maxAttempts.ok) return maxAttempts;

  const maxDoublings = parseIntegerField(record.maxDoublings, 'maxDoublings', 0, env);
  if (!maxDoublings.ok) return maxDoublings;

  const maxRetrySeconds = parseDurationSecondsField(record.maxRetrySeconds, 'maxRetrySeconds', env);
  if (!maxRetrySeconds.ok) return maxRetrySeconds;

  const minBackoffSeconds = parseDurationSecondsField(
    record.minBackoffSeconds,
    'minBackoffSeconds',
    env,
  );
  if (!minBackoffSeconds.ok) return minBackoffSeconds;

  const maxBackoffSeconds = parseDurationSecondsField(
    record.maxBackoffSeconds,
    'maxBackoffSeconds',
    env,
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
export function validateTasksRateLimits(
  rawRateLimits: unknown,
  env?: ParamsEnvMap,
): TasksRateLimitsValidationResult {
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
    env,
  );
  if (!maxConcurrentDispatches.ok) return maxConcurrentDispatches;

  let maxDispatchesPerSecond: number | undefined;
  const rawRate = record.maxDispatchesPerSecond;
  if (rawRate !== undefined && rawRate !== null && !isResetValueObject(rawRate)) {
    let candidate: unknown = rawRate;
    if (isParamExpression(rawRate)) {
      const resolved = resolveParamExpression(rawRate, env);
      if (!resolved.ok) {
        return { ok: false, kind: 'dynamic', reason: 'dynamic maxDispatchesPerSecond' };
      }
      candidate = resolved.value;
    } else if (typeof rawRate === 'object') {
      return { ok: false, kind: 'dynamic', reason: 'dynamic maxDispatchesPerSecond' };
    }
    if (candidate !== undefined && candidate !== null && !isResetValueObject(candidate)) {
      if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate <= 0) {
        return {
          ok: false,
          kind: 'invalid',
          reason: 'maxDispatchesPerSecond must be a positive number',
        };
      }
      maxDispatchesPerSecond = candidate;
    }
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
