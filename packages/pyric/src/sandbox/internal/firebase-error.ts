/**
 * Firebase-shaped error primitive shared by the sandbox client mirrors.
 *
 * It lives below every service surface so mirrors can preserve cross-service
 * `instanceof FirebaseError` identity without depending on the app composition
 * root or loading the production SDK.
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

// Served SDK bundles are minified. Firebase exposes a stable constructor name,
// and production lifecycle observations assert it independently of `error.name`.
Object.defineProperty(FirebaseError, 'name', { value: 'FirebaseError' });
