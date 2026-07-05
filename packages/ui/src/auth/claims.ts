/**
 * Custom-claims validation for the add-account form — same checks and
 * user-facing messages as the Firebase emulator UI (which reuses the
 * Auth emulator's server validation: JSON-object shape, 1000-char cap,
 * reserved-key deny list).
 */

/** Reserved JWT/OIDC keys the Auth emulator rejects as custom claims.
 *  https://firebase.google.com/docs/auth/admin/create-custom-tokens */
export const FORBIDDEN_CUSTOM_CLAIMS: readonly string[] = [
  'iss',
  'aud',
  'sub',
  'iat',
  'exp',
  'nbf',
  'jti',
  'nonce',
  'azp',
  'acr',
  'amr',
  'cnf',
  'auth_time',
  'firebase',
  'at_hash',
  'c_hash',
];

/** Serialized-length cap, matching the emulator's `CUSTOM_ATTRIBUTES_MAX_LENGTH`. */
export const CUSTOM_CLAIMS_MAX_LENGTH = 1000;

export type ClaimsValidationResult =
  /** `claims` is `undefined` when the input was empty/whitespace. */
  | { ok: true; claims: Record<string, unknown> | undefined }
  | { ok: false; message: string };

/**
 * Validate the claims textarea's raw text. Empty input is valid (no
 * claims). Messages match the emulator UI verbatim so users see the
 * same wording in both tools.
 */
export function validateSerializedClaims(text: string): ClaimsValidationResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, claims: undefined };
  if (trimmed.length > CUSTOM_CLAIMS_MAX_LENGTH) {
    return { ok: false, message: 'Custom claims length must not exceed 1000 characters' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, message: 'Custom claims must be a valid JSON object' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: 'Custom claims must be a valid JSON object' };
  }
  for (const key of FORBIDDEN_CUSTOM_CLAIMS) {
    if (key in parsed) {
      return { ok: false, message: `Custom claims must not have forbidden key: ${key}` };
    }
  }
  return { ok: true, claims: parsed as Record<string, unknown> };
}
