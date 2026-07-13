/**
 * The public error primitive shared by the sandbox client mirrors.
 *
 * Its observable shape follows `firebase/app`'s `FirebaseError`, while living
 * entirely inside `pyric` so sandbox errors never load the production SDK.
 */
export class FirebaseError extends Error {
  readonly name = 'FirebaseError';

  constructor(
    readonly code: string,
    message: string,
    readonly customData?: Record<string, unknown>,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
