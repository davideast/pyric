import { PrefixedFirebaseError, type ErrorInfo } from '../app/firebase-error.js';

export const DatabaseErrorCode = {
  INTERNAL_ERROR: 'internal-error',
  INVALID_ARGUMENT: 'invalid-argument',
} as const;

/**
 * Runtime error constructor mirroring `firebase-admin/database`'s
 * `FirebaseDatabaseError` (`lib/database/error.js`, v14.5.1).
 */
export class FirebaseDatabaseError extends PrefixedFirebaseError {
  constructor(info: ErrorInfo, message?: string) {
    let resolvedMessage = info.message;
    if (message !== undefined && message !== '') {
      resolvedMessage = message;
    }
    super('database', info.code, resolvedMessage, {
      httpResponse: info.httpResponse,
      cause: info.cause,
    });
  }
}
