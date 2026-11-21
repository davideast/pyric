/**
 * `FunctionsError` and HTTP-to-RPC error mapping, matching
 * `@firebase/functions` 0.14.0 (`_errorForResponse`, `codeForHTTPStatus`).
 */
import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import { decode } from './serializer.js';
import type { FunctionsErrorCodeCore } from './types.js';

const FUNCTIONS_TYPE = 'functions';

const ERROR_CODE_MAP: Readonly<Record<string, FunctionsErrorCodeCore>> = {
  OK: 'ok',
  CANCELLED: 'cancelled',
  UNKNOWN: 'unknown',
  INVALID_ARGUMENT: 'invalid-argument',
  DEADLINE_EXCEEDED: 'deadline-exceeded',
  NOT_FOUND: 'not-found',
  ALREADY_EXISTS: 'already-exists',
  PERMISSION_DENIED: 'permission-denied',
  UNAUTHENTICATED: 'unauthenticated',
  RESOURCE_EXHAUSTED: 'resource-exhausted',
  FAILED_PRECONDITION: 'failed-precondition',
  ABORTED: 'aborted',
  OUT_OF_RANGE: 'out-of-range',
  UNIMPLEMENTED: 'unimplemented',
  INTERNAL: 'internal',
  UNAVAILABLE: 'unavailable',
  DATA_LOSS: 'data-loss',
};

/**
 * Error returned by the Firebase Functions client SDK.
 */
export class FunctionsError extends FirebaseError {
  readonly details?: unknown;

  constructor(
    code: FunctionsErrorCodeCore,
    message?: string,
    details?: unknown,
    url?: string,
  ) {
    let resolvedMessage = '';
    if (message) {
      resolvedMessage = message;
    }
    let customData: Record<string, unknown> | undefined;
    if (url !== undefined && url !== null) {
      customData = { url };
    }
    super(`${FUNCTIONS_TYPE}/${code}`, resolvedMessage, customData);
    this.details = details;
    Object.setPrototypeOf(this, FunctionsError.prototype);
  }
}

Object.defineProperty(FunctionsError, 'name', { value: 'FunctionsError' });

/**
 * Maps an HTTP status code to a standard `FunctionsErrorCodeCore`.
 */
export function codeForHTTPStatus(status: number): FunctionsErrorCodeCore {
  if (status >= 200 && status < 300) {
    return 'ok';
  }
  switch (status) {
    case 0:
      return 'internal';
    case 400:
      return 'invalid-argument';
    case 401:
      return 'unauthenticated';
    case 403:
      return 'permission-denied';
    case 404:
      return 'not-found';
    case 409:
      return 'aborted';
    case 429:
      return 'resource-exhausted';
    case 499:
      return 'cancelled';
    case 500:
      return 'internal';
    case 501:
      return 'unimplemented';
    case 503:
      return 'unavailable';
    case 504:
      return 'deadline-exceeded';
    default:
      return 'unknown';
  }
}

/**
 * Converts an HTTP status and parsed JSON body into a `FunctionsError`, or
 * `null` when the response represents a successful (`ok`) call.
 */
export function errorForResponse(
  httpStatus: number,
  bodyJSON: unknown,
  url?: string,
): FunctionsError | null {
  let code: FunctionsErrorCodeCore = codeForHTTPStatus(httpStatus);
  let description: string = code;
  let details: unknown;

  try {
    if (typeof bodyJSON === 'object' && bodyJSON !== null) {
      const errorField = (bodyJSON as { error?: unknown }).error;
      if (typeof errorField === 'object' && errorField !== null) {
        const errorJSON = errorField as Record<string, unknown>;
        const statusText = errorJSON.status;
        if (typeof statusText === 'string') {
          const mapped = ERROR_CODE_MAP[statusText];
          if (!mapped) {
            return new FunctionsError(
              'internal',
              `Unknown backend error status: ${statusText} [${httpStatus}]`,
              undefined,
              url,
            );
          }
          code = mapped;
          description = `Backend error status: ${statusText}`;
        }
        if (typeof errorJSON.message === 'string') {
          description = errorJSON.message;
        }
        details = errorJSON.details;
        if (details !== undefined) {
          details = decode(details);
        }
      }
    }
  } catch {
    // Ignore malformed error fields and fall back to status-derived defaults.
  }

  if (code === 'ok') {
    return null;
  }
  return new FunctionsError(code, `${description} [${httpStatus}]`, details, url);
}
