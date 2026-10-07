/**
 * The standard claims a Firebase ID token carries for an account, projected
 * from the account record. Shared by the Auth token minter, the served worker,
 * and the MCP identity surface, so every rules engine (Firestore, Realtime
 * Database, Storage) reads the same `auth.token`.
 *
 * Shape, as decoded from production ID tokens per sign-in flow:
 *
 * - `user_id` always equals the uid; `provider_id: 'anonymous'` appears on
 *   anonymous accounts only.
 * - `email` and `email_verified` appear together when the account has an
 *   email address.
 * - `name`, `picture` and `phone_number` appear only when the account has a
 *   display name, photo URL or phone number.
 * - `firebase.identities` is always present: `{}` for an account with no
 *   email, phone number or linked federated provider; otherwise keyed by
 *   identity type. The email address is listed under `email` (also for a
 *   password account), the phone number under `phone`, and each linked
 *   federated provider under its provider ID.
 *
 * When a custom claim reuses one of these names, the account value wins for
 * `user_id`, `email`, `email_verified`, `phone_number`, and `provider_id` on
 * an anonymous account; the custom value wins for `name`, `picture`, and
 * `provider_id` on any other account.
 */

import { FirebaseError } from './firebase-error.js';

/** JWT registered claims a minter adds around the account claim set. */
const JWT_REGISTERED_CLAIMS = ['sub', 'aud', 'iss', 'auth_time', 'iat', 'exp'] as const;

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

/** A token claim set without the JWT registered claims: the value rules
 *  read on `auth.token`. */
export function withoutJwtClaims(tokenClaims: Record<string, unknown>): Record<string, unknown> {
  const claims: Record<string, unknown> = { ...tokenClaims };
  for (const key of JWT_REGISTERED_CLAIMS) delete claims[key];
  return claims;
}

/** The account fields the projection reads. */
export interface TokenClaimAccount {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  photoUrl: string | null;
  phoneNumber: string | null;
  isAnonymous: boolean;
  /** Provider IDs linked to the account (`password`, `phone`, `google.com`, ...). */
  providerIds: readonly string[];
}

/** An Auth account record, stored or listed: the fields the projection reads. */
export interface TokenClaimRecord {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  photoUrl: string | null;
  phoneNumber: string | null;
  isAnonymous: boolean;
  providerUserInfo: ReadonlyArray<{ providerId: string }>;
}

export function tokenClaimAccount(record: TokenClaimRecord): TokenClaimAccount {
  return {
    uid: record.uid,
    email: record.email,
    emailVerified: record.emailVerified,
    displayName: record.displayName,
    photoUrl: record.photoUrl,
    phoneNumber: record.phoneNumber,
    isAnonymous: record.isAnonymous,
    providerIds: record.providerUserInfo.map((p) => p.providerId),
  };
}

/** Provider IDs whose identity is listed under another key: a password
 *  account's identity is its email address, a phone account's its number. */
const NON_FEDERATED_PROVIDERS = new Set(['password', 'phone', 'anonymous']);

/**
 * The claim set an ID token carries, without the JWT registered claims: the
 * account's `name` and `picture`, custom claims over them, the account's
 * other standard claims over those, then the reserved `firebase` namespace
 * with the identities map and the session's sign-in provider. A `null`
 * account (an identity with no record) yields the custom claims, `user_id`,
 * and a `firebase` namespace with empty identities.
 */
export function accountTokenClaims(
  uid: string,
  account: TokenClaimAccount | null,
  customClaims: Record<string, unknown>,
  signInProvider: string | null,
): Record<string, unknown> {
  const customOverrides: Record<string, unknown> = {};
  const accountWins: Record<string, unknown> = { user_id: uid };
  const identities: Record<string, string[]> = {};
  if (account !== null) {
    if (account.displayName !== null) customOverrides.name = account.displayName;
    if (account.photoUrl !== null) customOverrides.picture = account.photoUrl;
    if (account.isAnonymous) accountWins.provider_id = 'anonymous';
    if (account.email !== null) {
      accountWins.email = account.email;
      accountWins.email_verified = account.emailVerified;
      identities.email = [account.email];
    }
    if (account.phoneNumber !== null) {
      accountWins.phone_number = account.phoneNumber;
      identities.phone = [account.phoneNumber];
    }
    // The sandbox records no provider-side account ID for a federated link,
    // so the uid stands in as the single listed identity.
    for (const providerId of account.providerIds) {
      if (NON_FEDERATED_PROVIDERS.has(providerId)) continue;
      identities[providerId] = [account.uid];
    }
  }
  return {
    ...customOverrides,
    ...customClaims,
    ...accountWins,
    firebase: { identities, sign_in_provider: signInProvider },
  };
}
