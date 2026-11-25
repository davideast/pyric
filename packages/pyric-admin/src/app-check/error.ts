import { PrefixedFirebaseError, type ErrorInfo } from '../app/firebase-error.js';

export const AppCheckErrorCode = {
  ABORTED: 'aborted',
  INVALID_ARGUMENT: 'invalid-argument',
  INVALID_CREDENTIAL: 'invalid-credential',
  INTERNAL: 'internal-error',
  PERMISSION_DENIED: 'permission-denied',
  UNAUTHENTICATED: 'unauthenticated',
  NOT_FOUND: 'not-found',
  APP_CHECK_TOKEN_EXPIRED: 'app-check-token-expired',
  UNKNOWN: 'unknown-error',
} as const;

export type AppCheckErrorCodeValue = (typeof AppCheckErrorCode)[keyof typeof AppCheckErrorCode];

/** firebase-admin's FirebaseAppCheckError: a PrefixedFirebaseError with prefix `app-check`. */
export class FirebaseAppCheckError extends PrefixedFirebaseError {
  constructor(codeOrInfo: AppCheckErrorCodeValue | ErrorInfo, message?: string) {
    if (typeof codeOrInfo === 'string') {
      super('app-check', codeOrInfo, message ?? '');
      return;
    }
    let resolvedMessage = codeOrInfo.message;
    if (message !== undefined && message !== '') {
      resolvedMessage = message;
    }
    super('app-check', codeOrInfo.code, resolvedMessage, {
      httpResponse: codeOrInfo.httpResponse,
      cause: codeOrInfo.cause,
    });
  }
}
