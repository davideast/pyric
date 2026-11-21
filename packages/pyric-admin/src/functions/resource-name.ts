/**
 * Validation and resource-name parsing for `firebase-admin/functions`
 * (`Functions.taskQueue`, `TaskQueue.enqueue`, and `TaskQueue.delete`),
 * mirroring `firebase-admin/lib/functions/functions-api-client-internal.js`.
 */
import { FirebaseFunctionsError } from './error.js';
import type { TaskOptions } from './types.js';

const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,500}$/;
const MAX_HEADERS_BYTES = 80 * 1024;
const MIN_DISPATCH_DEADLINE_SECONDS = 15;
const MAX_DISPATCH_DEADLINE_SECONDS = 1800;

interface ParsedFunctionResourceName {
  projectId?: string;
  locationId?: string;
  resourceId: string;
}

interface ValidatedTaskOptions {
  id?: string;
  scheduleDelaySeconds?: number;
  scheduleTimeIso?: string;
  dispatchDeadlineSeconds?: number;
  headers?: Record<string, string>;
  uri?: string;
}

/** Validate `id` against Cloud Tasks `[A-Za-z0-9_-]{1,500}` identifier rules. */
export function assertValidTaskId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !TASK_ID_PATTERN.test(id)) {
    throw new FirebaseFunctionsError(
      'invalid-argument',
      'id can contain only letters ([A-Za-z]), numbers ([0-9]), ' +
        'hyphens (-), or underscores (_). The maximum length is 500 characters.',
    );
  }
}

/**
 * Parse `{functionName}`, `locations/{loc}/functions/{name}`, or
 * `projects/{proj}/locations/{loc}/functions/{name}` plus optional `extensionId`.
 */
export function parseFunctionQueueResource(
  functionName: unknown,
  extensionId?: unknown,
): ParsedFunctionResourceName {
  if (typeof functionName !== 'string' || functionName.length === 0) {
    throw new FirebaseFunctionsError(
      'invalid-argument',
      'Function name must be a non empty string',
    );
  }
  if (extensionId !== undefined && typeof extensionId !== 'string') {
    throw new FirebaseFunctionsError(
      'invalid-argument',
      '`extensionId` must be a string.',
    );
  }

  let projectId: string | undefined;
  let locationId: string | undefined;
  let resourceId: string;

  if (!functionName.includes('/')) {
    resourceId = functionName;
  } else {
    const parts = functionName.split('/');
    if (
      parts.length === 4 &&
      parts[0] === 'locations' &&
      parts[2] === 'functions' &&
      (parts[1] ?? '').length > 0 &&
      (parts[3] ?? '').length > 0
    ) {
      locationId = parts[1];
      resourceId = parts[3] ?? '';
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
      resourceId = parts[5] ?? '';
    } else {
      throw new FirebaseFunctionsError(
        'invalid-argument',
        'Function name must be a single string or a qualified resource name',
      );
    }
  }

  if (resourceId.trim().length === 0) {
    throw new FirebaseFunctionsError(
      'invalid-argument',
      'No valid function name specified to enqueue tasks for.',
    );
  }

  if (typeof extensionId === 'string' && extensionId.length > 0) {
    resourceId = `ext-${extensionId}-${resourceId}`;
  }

  const parsed: ParsedFunctionResourceName = { resourceId };
  if (projectId !== undefined) {
    parsed.projectId = projectId;
  }
  if (locationId !== undefined) {
    parsed.locationId = locationId;
  }
  return parsed;
}

function isValidHttpUrl(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (err: unknown) {
    if (err instanceof TypeError) {
      return false;
    }
    throw err;
  }
}

function validateTaskHeaders(rawHeaders: unknown): Record<string, string> {
  if (typeof rawHeaders !== 'object' || rawHeaders === null || Array.isArray(rawHeaders)) {
    throw new FirebaseFunctionsError(
      'invalid-argument',
      'headers must be a non-null plain object of string values.',
    );
  }
  const normalized: Record<string, string> = {};
  let totalBytes = 0;
  for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
    if (key.length === 0 || typeof value !== 'string') {
      throw new FirebaseFunctionsError(
        'invalid-argument',
        `Header '${key}' must have a string value.`,
      );
    }
    normalized[key] = value;
    totalBytes += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value, 'utf8');
  }
  if (totalBytes >= MAX_HEADERS_BYTES) {
    throw new FirebaseFunctionsError(
      'invalid-argument',
      'Task headers size must be less than 80KB.',
    );
  }
  return normalized;
}

/** Validate `TaskOptions` synchronously/asynchronously matching `firebase-admin/functions`. */
export function validateEnqueueOptions(opts: TaskOptions | undefined): ValidatedTaskOptions {
  if (opts === undefined) {
    return {};
  }
  if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
    throw new FirebaseFunctionsError(
      'invalid-argument',
      'TaskOptions must be a non-null object',
    );
  }

  const hasScheduleTimeKey = 'scheduleTime' in opts;
  const hasScheduleDelayKey = 'scheduleDelaySeconds' in opts;
  if (hasScheduleTimeKey && hasScheduleDelayKey) {
    throw new FirebaseFunctionsError(
      'invalid-argument',
      'Both scheduleTime and scheduleDelaySeconds are provided. Only one value should be set.',
    );
  }

  const validated: ValidatedTaskOptions = {};

  if (hasScheduleTimeKey && opts.scheduleTime !== undefined) {
    const rawDate = opts.scheduleTime as unknown;
    if (!(rawDate instanceof Date) || !Number.isFinite(rawDate.getTime())) {
      throw new FirebaseFunctionsError(
        'invalid-argument',
        'scheduleTime must be a valid Date object.',
      );
    }
    validated.scheduleTimeIso = rawDate.toISOString();
  }

  if (hasScheduleDelayKey && opts.scheduleDelaySeconds !== undefined) {
    const rawDelay = opts.scheduleDelaySeconds as unknown;
    if (typeof rawDelay !== 'number' || !Number.isFinite(rawDelay) || rawDelay < 0) {
      throw new FirebaseFunctionsError(
        'invalid-argument',
        'scheduleDelaySeconds must be a non-negative duration in seconds.',
      );
    }
    validated.scheduleDelaySeconds = rawDelay;
  }

  if (opts.dispatchDeadlineSeconds !== undefined) {
    const rawDeadline = opts.dispatchDeadlineSeconds as unknown;
    if (
      typeof rawDeadline !== 'number' ||
      !Number.isFinite(rawDeadline) ||
      rawDeadline < MIN_DISPATCH_DEADLINE_SECONDS ||
      rawDeadline > MAX_DISPATCH_DEADLINE_SECONDS
    ) {
      throw new FirebaseFunctionsError(
        'invalid-argument',
        'dispatchDeadlineSeconds must be a non-negative duration in seconds ' +
          'and must be in the range of 15s to 30 mins.',
      );
    }
    validated.dispatchDeadlineSeconds = rawDeadline;
  }

  if ('id' in opts && opts.id !== undefined) {
    assertValidTaskId(opts.id);
    validated.id = opts.id;
  }

  if (opts.uri !== undefined) {
    if (typeof opts.uri !== 'string' || !isValidHttpUrl(opts.uri)) {
      throw new FirebaseFunctionsError('invalid-argument', 'uri must be a valid URL string.');
    }
    validated.uri = opts.uri;
  }

  if (opts.headers !== undefined) {
    validated.headers = validateTaskHeaders(opts.headers);
  }

  return validated;
}
