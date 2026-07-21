import type { FirestoreErrorCode, FirestoreSimError } from './errors.js';

/** Throwable Firebase-shaped error shared by the query engine and compat adapter. */
export class FirestoreCompatError extends Error {
  readonly code: FirestoreErrorCode;
  readonly simError: FirestoreSimError;

  constructor(error: FirestoreSimError) {
    super(error.message);
    this.name = 'FirestoreError';
    this.code = error.code;
    this.simError = error;
  }
}
