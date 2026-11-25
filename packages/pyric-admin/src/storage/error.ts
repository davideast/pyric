/**
 * `FirebaseStorageError` and `StorageErrorCode` matching `firebase-admin/storage`
 * (`lib/storage/error.js`, v14.5.1).
 */
import { PrefixedFirebaseError, type ErrorInfo } from '../app/firebase-error.js';

export const StorageErrorCode = {
  INVALID_ARGUMENT: 'invalid-argument',
  INVALID_EMULATOR_HOST: 'invalid-emulator-host',
  MISSING_DEPENDENCIES: 'missing-dependencies',
  INVALID_CREDENTIAL: 'invalid-credential',
  NO_DOWNLOAD_TOKEN: 'no-download-token',
} as const;

export class FirebaseStorageError extends PrefixedFirebaseError {
  constructor(
    codeOrInfo: (typeof StorageErrorCode)[keyof typeof StorageErrorCode] | ErrorInfo,
    message?: string,
  ) {
    if (typeof codeOrInfo === 'string') {
      super('storage', codeOrInfo, message ?? '');
      return;
    }
    let resolvedMessage = codeOrInfo.message;
    if (message !== undefined && message !== '') {
      resolvedMessage = message;
    }
    super('storage', codeOrInfo.code, resolvedMessage, {
      httpResponse: codeOrInfo.httpResponse,
      cause: codeOrInfo.cause,
    });
  }
}
