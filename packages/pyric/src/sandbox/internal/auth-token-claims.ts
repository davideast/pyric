import { FirebaseError } from './firebase-error.js';

/**
 * Developer claim names the Admin SDK refuses with `auth/reserved-claim`
 * (`RESERVED_CLAIMS` in firebase-admin's `auth-api-request`, confirmed by the
 * auth-id-token-standard-claims capture).
 */
export const RESERVED_CUSTOM_CLAIMS: readonly string[] = [
  'acr', 'amr', 'at_hash', 'aud', 'auth_time', 'azp', 'cnf', 'c_hash', 'exp', 'iat',
  'iss', 'jti', 'nbf', 'nonce', 'sub', 'firebase',
];

/**
 * Refuse a custom claim set that uses a reserved name, with the Admin SDK's
 * `auth/reserved-claim` code and message.
 */
export function assertNoReservedCustomClaims(claims: Record<string, unknown>): void {
  const used = RESERVED_CUSTOM_CLAIMS.filter((name) => Object.prototype.hasOwnProperty.call(claims, name));
  if (used.length === 0) return;
  const message = used.length > 1
    ? `Developer claims "${used.join('", "')}" are reserved and cannot be specified.`
    : `Developer claim "${used[0]}" is reserved and cannot be specified.`;
  throw new FirebaseError('auth/reserved-claim', message);
}
