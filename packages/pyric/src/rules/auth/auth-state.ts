/**
 * The rules engine's auth module: the identity a request carries into rules
 * evaluation, and the normalization that folds its tenant into the token. The
 * sandbox and the rules simulators import both from here.
 */

/**
 * A signed-in identity for a rules request or a sandbox operation. `null` is anonymous.
 *
 * `token` is the Firebase Auth token claims map (custom claims plus
 * standard ones). It surfaces the same way it does in production rules
 * via `request.auth.token.*`. Omit it for plain UID-only auth.
 *
 * Renamed from `AuthContext` (pre-multi-context) so the data type
 * doesn't visually collide with `SandboxContext` (the identity-bearing
 * handle). They sit at different layers, payload and handle, and the
 * names should reflect that.
 */
export type AuthState =
  | { uid: string; token?: Record<string, unknown>; tenant?: string }
  | null;

/**
 * Normalize an AuthState before rules read it.
 * Automatically projects top-level `tenant` into `token.firebase.tenant`
 * while preserving custom claims and explicit nested token overrides.
 * Never mutates original input.
 */
export function normalizeAuthState(auth: AuthState): AuthState {
  if (auth === null) return null;

  if (auth.tenant === undefined) {
    if (auth.token === undefined) {
      return { uid: auth.uid };
    }
    return {
      uid: auth.uid,
      token: structuredClone(auth.token),
    };
  }

  const token = auth.token !== undefined ? structuredClone(auth.token) : {};
  const existingFirebase = token.firebase;

  let normalizedFirebase: Record<string, unknown>;
  if (
    typeof existingFirebase === 'object' &&
    existingFirebase !== null &&
    !Array.isArray(existingFirebase)
  ) {
    const fbObj = existingFirebase as Record<string, unknown>;
    normalizedFirebase = {
      ...fbObj,
      tenant: fbObj.tenant !== undefined ? fbObj.tenant : auth.tenant,
    };
  } else {
    normalizedFirebase = { tenant: auth.tenant };
  }

  token.firebase = normalizedFirebase;

  return {
    uid: auth.uid,
    tenant: auth.tenant,
    token,
  };
}
