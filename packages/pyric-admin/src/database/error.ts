import { FirebaseError, type ErrorInfo } from '../app/firebase-error.js';

/**
 * Runtime error constructor mirroring `firebase-admin/database`'s
 * `FirebaseDatabaseError` (`lib/utils/error.js:170-183`).
 */
export class FirebaseDatabaseError extends FirebaseError {
  constructor(info: ErrorInfo, message?: string) {
    let resolvedMessage = info.message;
    if (message !== undefined && message !== '') {
      resolvedMessage = message;
    }
    super({ code: `database/${info.code}`, message: resolvedMessage });
  }
}
