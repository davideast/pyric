/**
 * Standard Firebase ID token claims stripped when recording sessions in a
 * repro capture (`captureReproBase` records `tenantId` and `signInProvider` on
 * sibling session fields, so `firebase` is omitted from `customClaims`).
 */
export const STANDARD_TOKEN_CLAIMS: ReadonlySet<string> = new Set([
  'firebase',
  'uid',
  'user_id',
  'sub',
  'iss',
  'aud',
  'iat',
  'exp',
  'auth_time',
  'email',
  'email_verified',
  'phone_number',
  'name',
  'picture',
  'nonce',
]);

/**
 * Non-email profile and decoded JWT envelope claims stripped from rule-denial
 * `auth.token` payloads on the worker wire while preserving custom claims,
 * email claims (`email`, `email_verified`), and sanitized `token.firebase`
 * (`tenant`, `sign_in_provider`, and `identities.email`).
 */
export const WIRE_STRIPPED_TOKEN_CLAIMS: ReadonlySet<string> = new Set([
  'phone_number',
  'name',
  'picture',
  'uid',
  'user_id',
  'sub',
  'iss',
  'aud',
  'iat',
  'exp',
  'auth_time',
  'nonce',
]);

/** Keep only non-standard custom claims from a decoded token, or `undefined` when none remain. */
export function stripStandardTokenClaims(
  token: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (token === undefined) return undefined;
  const customClaims: Record<string, unknown> = {};
  for (const [claim, val] of Object.entries(token)) {
    if (!STANDARD_TOKEN_CLAIMS.has(claim)) {
      customClaims[claim] = val;
    }
  }
  return Object.keys(customClaims).length > 0 ? customClaims : undefined;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Project `auth.token.firebase` for the worker wire, retaining `tenant`,
 * `sign_in_provider`, and string `identities.email` entries while dropping
 * non-email identity providers and metadata (or returning `undefined` when empty).
 */
function stripWireFirebaseClaim(firebaseClaim: unknown): Record<string, unknown> | undefined {
  if (!isPlainRecord(firebaseClaim)) return undefined;
  const wireFirebase: Record<string, unknown> = {};
  for (const [claimKey, claimValue] of Object.entries(firebaseClaim)) {
    if ((claimKey === 'tenant' || claimKey === 'sign_in_provider') && typeof claimValue === 'string') {
      wireFirebase[claimKey] = claimValue;
      continue;
    }
    if (claimKey === 'identities' && isPlainRecord(claimValue)) {
      const rawEmails = claimValue.email;
      if (Array.isArray(rawEmails)) {
        const emails = rawEmails.filter((item): item is string => typeof item === 'string');
        if (emails.length > 0) {
          wireFirebase.identities = { email: emails };
        }
      }
    }
  }
  return Object.keys(wireFirebase).length > 0 ? wireFirebase : undefined;
}

/**
 * Strip non-email profile and JWT envelope claims from a wire `auth.token`
 * object while preserving custom claims, `email` / `email_verified`, and
 * `tenant` / `sign_in_provider` / `identities.email` inside `token.firebase`
 * (omitting `firebase` if empty).
 */
export function stripWireTokenClaims(
  token: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (token === undefined) return undefined;
  const wireClaims: Record<string, unknown> = {};
  for (const [claim, val] of Object.entries(token)) {
    if (WIRE_STRIPPED_TOKEN_CLAIMS.has(claim)) continue;
    if (claim === 'firebase') {
      const wireFirebase = stripWireFirebaseClaim(val);
      if (wireFirebase !== undefined) {
        wireClaims.firebase = wireFirebase;
      }
      continue;
    }
    wireClaims[claim] = val;
  }
  return Object.keys(wireClaims).length > 0 ? wireClaims : undefined;
}
