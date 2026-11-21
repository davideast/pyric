/**
 * `FirebaseFunctionsError` matching `firebase-admin/functions` (`PrefixedFirebaseError`
 * under the `'functions'` service prefix).
 */
import { PrefixedFirebaseError } from '../app/firebase-error.js';

type FunctionsAdminErrorCode =
  | 'aborted'
  | 'failed-precondition'
  | 'internal-error'
  | 'invalid-argument'
  | 'invalid-credential'
  | 'not-found'
  | 'permission-denied'
  | 'task-already-exists'
  | 'unauthenticated'
  | 'unknown-error';

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
  constructor(code: FunctionsAdminErrorCode, message: string) {
    super('functions', code, message);
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
