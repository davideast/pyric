/**
 * Input validation and payload normalization helpers for `pyric/crashlytics`.
 */
import type { FirebaseApp } from '../app/types.js';
import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import type {
  CrashlyticsAttributes,
  CrashlyticsOptions,
  PlainCrashlyticsValue,
} from './types.js';

function isLoopbackHostname(hostname: string): boolean {
  let normalized = hostname.toLowerCase();
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    normalized = hostname.slice(1, -1).toLowerCase();
  }
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1'
  );
}

/**
 * Validates `options.endpointUrl`: permits omitted values, relative local paths
 * (such as `/__pyric/crashlytics`), and loopback HTTP(S) origins (`127.0.0.1`,
 * `localhost`, `[::1]`). Refuses any external host before network I/O.
 */
export function validateCrashlyticsEndpointUrl(endpointUrl: string | undefined): void {
  if (endpointUrl === undefined) {
    return;
  }
  const trimmed = endpointUrl.trim();
  if (trimmed.length === 0) {
    throw new FirebaseError(
      'crashlytics/invalid-endpoint',
      'Crashlytics: endpointUrl must not be empty (crashlytics/invalid-endpoint).',
    );
  }
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new FirebaseError(
      'crashlytics/invalid-endpoint',
      `Crashlytics: Invalid endpointUrl '${endpointUrl}' (crashlytics/invalid-endpoint).`,
    );
  }
  const isHttpScheme = parsed.protocol === 'http:' || parsed.protocol === 'https:';
  if (!isHttpScheme || !isLoopbackHostname(parsed.hostname)) {
    throw new FirebaseError(
      'crashlytics/invalid-endpoint',
      `Crashlytics: Refusing off-machine endpointUrl '${endpointUrl}' in sandbox mode (crashlytics/invalid-endpoint).`,
    );
  }
}

/** Converts OpenTelemetry `Attributes` (including primitive arrays) into plain wire scalars. */
export function normalizeCrashlyticsAttributes(
  attributes: CrashlyticsAttributes | undefined,
): Record<string, PlainCrashlyticsValue> {
  const normalized: Record<string, PlainCrashlyticsValue> = {};
  if (attributes === undefined) {
    return normalized;
  }
  for (const [key, rawValue] of Object.entries(attributes)) {
    if (rawValue === undefined) {
      continue;
    }
    if (
      typeof rawValue === 'string' ||
      typeof rawValue === 'boolean' ||
      (typeof rawValue === 'number' && Number.isFinite(rawValue))
    ) {
      normalized[key] = rawValue;
      continue;
    }
    if (Array.isArray(rawValue)) {
      normalized[key] = JSON.stringify(rawValue);
    }
  }
  return normalized;
}

/** Normalizes an arbitrary `unknown` error into structured `CrashlyticsRecordErrorInput` fields. */
export function normalizeThrownError(error: unknown): {
  name: string;
  message: string;
  stack: string | null;
  code: string | null;
  cause: string | null;
} {
  if (error instanceof Error) {
    let resolvedName = 'Error';
    if (typeof error.name === 'string' && error.name.length > 0) {
      resolvedName = error.name;
    }
    let resolvedStack = 'No stack trace available';
    if (typeof error.stack === 'string' && error.stack.length > 0) {
      resolvedStack = error.stack;
    }
    const errRecord = error as unknown as Record<string, unknown>;
    let resolvedCode: string | null = null;
    if (typeof errRecord.code === 'string') {
      resolvedCode = errRecord.code;
    } else if (typeof errRecord.code === 'number' && Number.isFinite(errRecord.code)) {
      resolvedCode = String(errRecord.code);
    }
    let resolvedCause: string | null = null;
    if (errRecord.cause instanceof Error) {
      resolvedCause = `${errRecord.cause.name}: ${errRecord.cause.message}`;
    } else if (typeof errRecord.cause === 'string') {
      resolvedCause = errRecord.cause;
    }
    return {
      name: resolvedName,
      message: error.message,
      stack: resolvedStack,
      code: resolvedCode,
      cause: resolvedCause,
    };
  }
  if (typeof error === 'string') {
    return {
      name: 'Error',
      message: error,
      stack: null,
      code: null,
      cause: null,
    };
  }
  if (typeof error === 'object' && error !== null) {
    const obj = error as Record<string, unknown>;
    let objName = 'Error';
    if (typeof obj.name === 'string' && obj.name.length > 0) {
      objName = obj.name;
    }
    let objStack: string | null = null;
    if (typeof obj.stack === 'string') {
      objStack = obj.stack;
    }
    let objCode: string | null = null;
    if (typeof obj.code === 'string') {
      objCode = obj.code;
    }
    if (typeof obj.message === 'string') {
      return {
        name: objName,
        message: obj.message,
        stack: objStack,
        code: objCode,
        cause: null,
      };
    }
    return {
      name: objName,
      message: 'Unknown error type: object',
      stack: objStack,
      code: objCode,
      cause: null,
    };
  }
  return {
    name: 'Error',
    message: `Unknown error type: ${typeof error}`,
    stack: null,
    code: null,
    cause: null,
  };
}

function deepEqualEnumerable(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (!deepEqualEnumerable(left[index], right[index])) {
        return false;
      }
    }
    return true;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(rightRecord, key)) {
      return false;
    }
    if (!deepEqualEnumerable(leftRecord[key], rightRecord[key])) {
      return false;
    }
  }
  return true;
}

function cloneEnumerableValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneEnumerableValue(item));
  }
  const cloned: Record<string, unknown> = {};
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    cloned[key] = cloneEnumerableValue(record[key]);
  }
  return cloned;
}

/** Captures an immutable snapshot of enumerable `CrashlyticsOptions` fields at initialization time. */
export function snapshotCrashlyticsOptions(
  options: CrashlyticsOptions | undefined,
): Record<string, unknown> {
  if (options === undefined) {
    return {};
  }
  return cloneEnumerableValue(options) as Record<string, unknown>;
}

/**
 * Compares `CrashlyticsOptions` using the same enumerable deep-equality rule as
 * `@firebase/crashlytics` (`deepEqual(options || {}, provider.getOptions())`).
 */
export function areCrashlyticsOptionsEqual(
  left: CrashlyticsOptions | Record<string, unknown> | undefined,
  right: CrashlyticsOptions | Record<string, unknown> | undefined,
): boolean {
  const normalizedLeft = left ?? {};
  const normalizedRight = right ?? {};
  return deepEqualEnumerable(normalizedLeft, normalizedRight);
}

export function appKeyOf(app: FirebaseApp): string {
  const configuredAppId = app.options.appId;
  if (typeof configuredAppId === 'string' && configuredAppId.length > 0) {
    return configuredAppId;
  }
  if (app.name === '[DEFAULT]') {
    return 'default';
  }
  return app.name;
}
