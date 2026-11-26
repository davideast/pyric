/**
 * Password credential verification for `/v1/accounts:signInWithPassword` flows:
 * `signInWithEmailAndPassword`, `signInWithCredential` with an email/password
 * credential, and `reauthenticateWithCredential` after its `user-mismatch` gate.
 *
 * Firebase projects enable Email Enumeration Protection by default, mapping
 * Identity Toolkit's `INVALID_LOGIN_CREDENTIALS` response to
 * `auth/invalid-credential` (`Firebase: Error (auth/invalid-credential).`) for
 * both unknown email addresses and wrong passwords (`auth#14`, `auth#15`,
 * `auth#170`). When a project disables Email Enumeration Protection, Identity
 * Toolkit answers `EMAIL_NOT_FOUND` (`auth/user-not-found`, `auth#14a`) and
 * `INVALID_PASSWORD` (`auth/wrong-password`, `auth#15b`, `auth#170a`).
 * Client-side format validation (`auth/invalid-email`) and empty password
 * rejection (`auth/missing-password`, `auth#15a`) still fire before any account
 * lookup, and disabled accounts still reject with `auth/user-disabled` (`auth#69`).
 */
import { makeAuthError } from '../auth-errors.js';
import { validateEmailFormat } from '../sandbox-credential-validators.js';
import type { StoredUser } from '../sandbox-backend-types.js';

const MISSING_PASSWORD_MESSAGE = 'Error';
const DISABLED_ACCOUNT_MESSAGE = 'The user account has been disabled by an administrator.';
const INVALID_CREDENTIAL_MESSAGE = 'Error';
const USER_NOT_FOUND_MESSAGE = 'Error';
const WRONG_PASSWORD_MESSAGE = 'Error';

function isMissingPassword(password: unknown): boolean {
  return typeof password !== 'string' || password.length === 0;
}

/**
 * Validate `email` and `password` against the account returned by `lookupByEmail`
 * and return the matching `StoredUser`.
 */
export function verifyPasswordSignIn(
  email: string,
  password: string,
  lookupByEmail: (email: string) => StoredUser | undefined,
  emailEnumerationProtection = true,
): StoredUser {
  validateEmailFormat(email);
  if (isMissingPassword(password)) {
    throw makeAuthError('auth/missing-password', MISSING_PASSWORD_MESSAGE);
  }
  const stored = lookupByEmail(email);
  if (stored === undefined) {
    if (emailEnumerationProtection) {
      throw makeAuthError('auth/invalid-credential', INVALID_CREDENTIAL_MESSAGE);
    }
    throw makeAuthError('auth/user-not-found', USER_NOT_FOUND_MESSAGE);
  }
  if (stored.disabled) {
    throw makeAuthError('auth/user-disabled', DISABLED_ACCOUNT_MESSAGE);
  }
  if (stored.password === null || stored.password !== password) {
    if (emailEnumerationProtection) {
      throw makeAuthError('auth/invalid-credential', INVALID_CREDENTIAL_MESSAGE);
    }
    throw makeAuthError('auth/wrong-password', WRONG_PASSWORD_MESSAGE);
  }
  return stored;
}
