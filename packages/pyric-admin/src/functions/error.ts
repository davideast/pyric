/**
 * `FirebaseFunctionsError` and `FunctionsErrorCode` matching `firebase-admin/functions`
 * (`PrefixedFirebaseError` under the `'functions'` service prefix, v14.5.1).
 */
import { PrefixedFirebaseError, type ErrorInfo } from '../app/firebase-error.js';

export const FunctionsErrorCode = {
  ABORTED: 'aborted',
  INVALID_ARGUMENT: 'invalid-argument',
  INVALID_CREDENTIAL: 'invalid-credential',
  INTERNAL_ERROR: 'internal-error',
  FAILED_PRECONDITION: 'failed-precondition',
  PERMISSION_DENIED: 'permission-denied',
  UNAUTHENTICATED: 'unauthenticated',
  NOT_FOUND: 'not-found',
  UNKNOWN_ERROR: 'unknown-error',
  TASK_ALREADY_EXISTS: 'task-already-exists',
} as const;

type FunctionsAdminErrorCode = (typeof FunctionsErrorCode)[keyof typeof FunctionsErrorCode];

const KNOWN_FUNCTIONS_CODES = new Set<FunctionsAdminErrorCode>([
  'aborted',
  'failed-precondition',
  'internal-error',
  'invalid-argument',
  'invalid-credential',
  'not-found',
  'permission-denied',
  'task-already-exists',
  'unauthenticated',
  'unknown-error',
]);

export class FirebaseFunctionsError extends PrefixedFirebaseError {
  constructor(codeOrInfo: FunctionsAdminErrorCode | ErrorInfo, message?: string) {
    if (typeof codeOrInfo === 'string') {
      super('functions', codeOrInfo, message ?? '');
      this.name = 'FirebaseFunctionsError';
      Object.setPrototypeOf(this, new.target.prototype);
      return;
    }
    let resolvedMessage = codeOrInfo.message;
    if (message !== undefined && message !== '') {
      resolvedMessage = message;
    }
    super('functions', codeOrInfo.code, resolvedMessage, {
      httpResponse: codeOrInfo.httpResponse,
      cause: codeOrInfo.cause,
    });
    this.name = 'FirebaseFunctionsError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Normalize cross-boundary coded `functions/*` errors into `FirebaseFunctionsError`. */
export function normalizeToFirebaseFunctionsError(err: unknown): unknown {
  if (err instanceof FirebaseFunctionsError) {
    return err;
  }
  if (typeof err === 'object' && err !== null) {
    const rawCode = (err as { code?: unknown }).code;
    if (typeof rawCode === 'string' && rawCode.startsWith('functions/')) {
      const shortCode = rawCode.slice('functions/'.length) as FunctionsAdminErrorCode;
      const message = err instanceof Error ? err.message : String(err);
      if (KNOWN_FUNCTIONS_CODES.has(shortCode)) {
        return new FirebaseFunctionsError(shortCode, message);
      }
      return new FirebaseFunctionsError('internal-error', message);
    }
  }
  return err;
}
