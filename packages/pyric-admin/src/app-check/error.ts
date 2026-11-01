import { PrefixedFirebaseError } from '../app/firebase-error.js';

export type AppCheckErrorCode = 'invalid-argument' | 'invalid-credential' | 'app-check-token-expired' | 'unknown-error';

/** firebase-admin's FirebaseAppCheckError: a PrefixedFirebaseError with prefix `app-check`. */
export class FirebaseAppCheckError extends PrefixedFirebaseError {
  constructor(code: AppCheckErrorCode, message: string) {
    super('app-check', code, message);
  }
}
