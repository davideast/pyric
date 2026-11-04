/**
 * `verifyIdToken` for `pyric-admin/auth`, shared by the in-process and remote
 * arms. Each arm passes the project the token must be scoped to and the
 * current time on its own clock.
 */
import { PrefixedFirebaseError } from '../app/firebase-error.js';
import type { DecodedIdToken } from './types.js';
import { checkClientIdToken, type IdTokenFailureCode } from './token-decoders.js';

/** firebase-admin's FirebaseAuthError: a PrefixedFirebaseError with prefix `auth`. */
export class FirebaseAuthError extends PrefixedFirebaseError {
  constructor(code: IdTokenFailureCode, message: string) {
    super('auth', code, message);
  }
}

/** What one verification checks against. */
export interface IdTokenExpectation {
  /** The project the token's `aud` and `iss` must name. */
  projectId: string;
  /** The current time, in epoch milliseconds, that `nbf` and `exp` are read against. */
  nowMs: number;
}

const NOT_A_STRING = 'First argument to verifyIdToken() must be a Firebase ID token string.';

/**
 * Verifies an ID token minted by pyric's Auth for `expected.projectId`.
 *
 * A token that is not a string throws `auth/argument-error` synchronously, as
 * firebase-admin's `verifyJWT` does. Every other failure rejects with
 * `auth/argument-error`, or `auth/id-token-expired` for an expired token.
 */
export function verifySandboxIdToken(idToken: string, expected: IdTokenExpectation): Promise<DecodedIdToken> {
  const isInvalidTokenArgument = typeof idToken !== 'string';
  if (isInvalidTokenArgument) throw new FirebaseAuthError('argument-error', NOT_A_STRING);
  const nowSec = Math.floor(expected.nowMs / 1000);
  return checkClientIdToken(idToken, expected.projectId, nowSec).then((verdict) => {
    if (!verdict.ok) throw new FirebaseAuthError(verdict.code, verdict.message);
    return verdict.token;
  });
}
