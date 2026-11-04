/**
 * `verifyIdToken` for `pyric-admin/auth`, shared by the in-process and remote
 * arms. Each arm passes the project the token must be scoped to and the
 * current time on its own clock.
 */
import type { AuthAccountStanding } from 'pyric/sandbox/internal';
import { PrefixedFirebaseError } from '../app/firebase-error.js';
import type { DecodedIdToken } from './types.js';
import { checkClientIdToken, type IdTokenFailureCode } from './token-decoders.js';

/** The codes `checkRevoked` and `revokeRefreshTokens` add to a token check's. */
type AccountFailureCode = 'user-not-found' | 'user-disabled' | 'id-token-revoked' | 'invalid-uid';

/** firebase-admin's FirebaseAuthError: a PrefixedFirebaseError with prefix `auth`. */
export class FirebaseAuthError extends PrefixedFirebaseError {
  constructor(code: IdTokenFailureCode | AccountFailureCode, message: string) {
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

/**
 * firebase-admin's answer for a uid that is not a non-empty string of at most
 * 128 characters (13.10.0 `validator.isUid`), checked before any request.
 */
export function invalidUid(uid: unknown): FirebaseAuthError | null {
  const isUid = typeof uid === 'string' && uid.length > 0 && uid.length <= 128;
  if (isUid) return null;
  return new FirebaseAuthError('invalid-uid', 'The uid must be a non-empty string with at most 128 characters.');
}

/** firebase-admin's `getUser` answer for a uid with no record. */
export function userNotFound(): FirebaseAuthError {
  return new FirebaseAuthError('user-not-found', 'There is no user record corresponding to the provided identifier.');
}

/**
 * firebase-admin's `verifyDecodedJWTNotRevokedOrDisabled` (13.10.0
 * `lib/auth/base-auth.js`), the `checkRevoked` step: the account must exist,
 * be enabled, and have no revocation after the token's `auth_time`, compared
 * in whole seconds as production stores it.
 */
export function assertNotRevokedOrDisabled(decoded: DecodedIdToken, standing: AuthAccountStanding): DecodedIdToken {
  const hasNoRecord = standing.kind === 'deleted' || standing.kind === 'unrecorded';
  if (hasNoRecord) throw userNotFound();
  if (standing.kind === 'disabled') throw new FirebaseAuthError('user-disabled', 'The user record is disabled.');
  const validAfterMs = standing.tokensValidAfterMs;
  const revoked = validAfterMs !== null && decoded.auth_time * 1000 < validAfterMs;
  if (revoked) throw new FirebaseAuthError('id-token-revoked', 'The Firebase ID token has been revoked.');
  return decoded;
}
