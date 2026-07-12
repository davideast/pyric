/**
 * Credential-input validators — email format and password strength.
 * Pure functions that throw the oracle-pinned `auth/invalid-email` /
 * `auth/weak-password` FirebaseErrors. Extracted verbatim from
 * `sandbox-backend.ts`; the backend core and the admin user surface
 * call these before touching the user DB.
 */

import { makeAuthError } from './auth-errors.js';

/**
 * Empirical match for prod's email-format rejection (matrix row #18).
 * Prod uses a permissive regex — local-part + `@` + domain-with-dot
 * is the practical bar. We mirror that shape: reject empty, reject
 * missing `@`, reject empty local-part or empty domain-part. Anything
 * else passes; consumer code that ships a more exotic-but-valid
 * address (quoted local-parts, IDN domains, etc.) should still
 * round-trip the same as prod.
 *
 * Throws `auth/invalid-email` with a message matching prod's shape so
 * consumer code that switches on `.code` sees the same error in
 * sandbox + prod. Oracle observation:
 * `scripts/oracle/observations/auth-row-18-invalid-email-error-code.json`.
 */
export function validateEmailFormat(email: string): void {
  if (typeof email !== 'string' || email.length === 0) {
    throw makeAuthError('auth/invalid-email', 'Error');
  }
  const atIdx = email.indexOf('@');
  // No `@`, or `@` at start (empty local-part), or `@` at end (empty
  // domain). Prod also rejects domains without a dot, but we stay
  // permissive there — the empirical oracle observation only locks
  // the `not-an-email` rejection.
  if (atIdx <= 0 || atIdx === email.length - 1) {
    throw makeAuthError('auth/invalid-email', 'Error');
  }
}

/**
 * Empirical match for prod's password-strength rejection (matrix
 * row #19). Prod's observed message is "Password should be at least
 * 6 characters" with code `auth/weak-password`. Oracle observation:
 * `scripts/oracle/observations/auth-row-19-weak-password-error-code.json`.
 */
export function validatePasswordStrength(password: string): void {
  if (typeof password !== 'string' || password.length < 6) {
    throw makeAuthError(
      'auth/weak-password',
      'Password should be at least 6 characters',
    );
  }
}
