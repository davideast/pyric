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
 * Profile and decoded JWT envelope claims stripped from rule-denial `auth.token`
 * payloads on the worker wire while preserving custom claims and sanitized
 * `token.firebase` (`tenant` and `sign_in_provider`).
 */
export const WIRE_STRIPPED_TOKEN_CLAIMS: ReadonlySet<string> = new Set([
  'email',
  'email_verified',
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

/**
 * Strip profile and JWT envelope claims from a wire `auth.token` object while
 * preserving custom claims and string `tenant` / `sign_in_provider` inside
 * `token.firebase` (dropping `identities` and omitting `firebase` if empty).
 */
export function stripWireTokenClaims(
  token: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (token === undefined) return undefined;
  const wireClaims: Record<string, unknown> = {};
  for (const [claim, val] of Object.entries(token)) {
    if (WIRE_STRIPPED_TOKEN_CLAIMS.has(claim)) continue;
    if (claim === 'firebase') {
      if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
        const wireFirebase: Record<string, unknown> = {};
        for (const [fbKey, fbVal] of Object.entries(val as Record<string, unknown>)) {
          if ((fbKey === 'tenant' || fbKey === 'sign_in_provider') && typeof fbVal === 'string') {
            wireFirebase[fbKey] = fbVal;
          }
        }
        if (Object.keys(wireFirebase).length > 0) {
          wireClaims.firebase = wireFirebase;
        }
      }
      continue;
    }
    wireClaims[claim] = val;
  }
  return Object.keys(wireClaims).length > 0 ? wireClaims : undefined;
}
