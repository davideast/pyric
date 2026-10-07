/**
 * The standard claims a Firebase ID token carries for an account, projected
 * from the account record. Shared by the Auth token minter and by the
 * `auth.token` value the Firestore, Realtime Database and Storage rules
 * engines read, so every service sees the same claim set.
 *
 * Shape, as decoded from production ID tokens per sign-in flow:
 *
 * - `email` and `email_verified` appear together when the account has an
 *   email address.
 * - `name`, `picture` and `phone_number` appear only when the account has a
 *   display name, photo URL or phone number.
 * - `user_id` always equals the uid; `provider_id: 'anonymous'` appears on
 *   anonymous accounts only.
 * - `firebase.identities` is always present: `{}` for an account with no
 *   email, phone number or linked federated provider; otherwise keyed by
 *   identity type. The email address is listed under `email` (also for a
 *   password account), the phone number under `phone`, and each linked
 *   federated provider under its provider ID.
 * - Account values win over custom claims that reuse the same name; a custom
 *   claim keeps its value when the account has no value for that claim.
 */

/** JWT registered claims a minter adds around the account claim set. */
const JWT_REGISTERED_CLAIMS = ['sub', 'aud', 'iss', 'auth_time', 'iat', 'exp'] as const;

/** Claims projected from the account record (see {@link standardTokenClaims}). */
const ACCOUNT_CLAIMS = ['user_id', 'provider_id', 'email', 'email_verified', 'name', 'picture', 'phone_number'] as const;

/** A token claim set without the JWT registered claims: the value rules
 *  read on `auth.token`. */
export function withoutJwtClaims(tokenClaims: Record<string, unknown>): Record<string, unknown> {
  const claims: Record<string, unknown> = { ...tokenClaims };
  for (const key of JWT_REGISTERED_CLAIMS) delete claims[key];
  return claims;
}

/**
 * The custom claims recoverable from a decoded token: everything except the
 * JWT registered claims, the account claims, and the reserved `firebase`
 * namespace. A custom claim that reuses an account claim name is not
 * recoverable from the token alone and is dropped.
 */
export function customClaimsFromToken(tokenClaims: Record<string, unknown>): Record<string, unknown> {
  const claims = withoutJwtClaims(tokenClaims);
  for (const key of ACCOUNT_CLAIMS) delete claims[key];
  delete claims.firebase;
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

/** Top-level standard claims plus the `firebase.identities` map. */
export interface StandardTokenClaims {
  claims: Record<string, unknown>;
  identities: Record<string, string[]>;
}

/** Provider IDs whose identity is listed under another key: a password
 *  account's identity is its email address, a phone account's its number. */
const NON_FEDERATED_PROVIDERS = new Set(['password', 'phone', 'anonymous']);

export function standardTokenClaims(account: TokenClaimAccount): StandardTokenClaims {
  const claims: Record<string, unknown> = { user_id: account.uid };
  const identities: Record<string, string[]> = {};
  if (account.isAnonymous) claims.provider_id = 'anonymous';
  if (account.email !== null) {
    claims.email = account.email;
    claims.email_verified = account.emailVerified;
    identities.email = [account.email];
  }
  if (account.displayName !== null) claims.name = account.displayName;
  if (account.photoUrl !== null) claims.picture = account.photoUrl;
  if (account.phoneNumber !== null) {
    claims.phone_number = account.phoneNumber;
    identities.phone = [account.phoneNumber];
  }
  // The sandbox records no provider-side account ID for a federated link, so
  // the uid stands in as the single listed identity.
  for (const providerId of account.providerIds) {
    if (NON_FEDERATED_PROVIDERS.has(providerId)) continue;
    identities[providerId] = [account.uid];
  }
  return { claims, identities };
}

/**
 * The claim set an ID token carries: custom claims, then the account's
 * standard claims over them, then the reserved `firebase` namespace with the
 * identities map and the session's sign-in provider. A `null` account (an
 * identity with no record) yields the custom claims, `user_id`, and a
 * `firebase` namespace with empty identities.
 */
export function accountTokenClaims(
  uid: string,
  account: TokenClaimAccount | null,
  customClaims: Record<string, unknown>,
  signInProvider: string | null,
): Record<string, unknown> {
  const standard = account === null ? { claims: { user_id: uid }, identities: {} } : standardTokenClaims(account);
  return {
    ...customClaims,
    ...standard.claims,
    firebase: { identities: standard.identities, sign_in_provider: signInProvider },
  };
}
