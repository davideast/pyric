/**
 * Password credential verification for `/v1/accounts:signInWithPassword` flows:
 * `signInWithEmailAndPassword`, `signInWithCredential` with an email/password
 * credential, and `reauthenticateWithCredential` after its `user-mismatch` gate.
 *
 * Firebase projects enable Email Enumeration Protection by default, mapping
 * Identity Toolkit's `INVALID_LOGIN_CREDENTIALS` response to
 * `auth/invalid-credential` (`Firebase: Error (auth/invalid-credential).`) for
 * both unknown email addresses and wrong passwords (`auth#14`, `auth#15`,
 * `auth#170`). Client-side format validation (`auth/invalid-email`) and empty
 * password rejection (`auth/missing-password`, `auth#15a`) still fire before
 * any account lookup, and disabled accounts still reject with
 * `auth/user-disabled` (`auth#69`).
 */
import { makeAuthError } from '../auth-errors.js';
import { validateEmailFormat } from '../sandbox-credential-validators.js';
import type { StoredUser } from '../sandbox-backend-types.js';

const MISSING_PASSWORD_MESSAGE = 'A non-empty password must be provided';
const DISABLED_ACCOUNT_MESSAGE = 'The user account has been disabled by an administrator.';
const INVALID_CREDENTIAL_MESSAGE = 'Error';

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
): StoredUser {
  validateEmailFormat(email);
  if (isMissingPassword(password)) {
    throw makeAuthError('auth/missing-password', MISSING_PASSWORD_MESSAGE);
  }
  const stored = lookupByEmail(email);
  if (stored === undefined) {
    throw makeAuthError('auth/invalid-credential', INVALID_CREDENTIAL_MESSAGE);
  }
  if (stored.disabled) {
    throw makeAuthError('auth/user-disabled', DISABLED_ACCOUNT_MESSAGE);
  }
  if (stored.password !== password) {
    throw makeAuthError('auth/invalid-credential', INVALID_CREDENTIAL_MESSAGE);
  }
  return stored;
}
