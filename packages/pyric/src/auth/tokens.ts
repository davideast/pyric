/**
 * Token-scoped operations: `signInWithCustomToken` (sign in FROM a token)
 * and `revokeAccessToken` (revoke a provider's token), plus
 * `validatePassword` (the project password policy).
 */

import { makeAuthError } from './auth-errors.js';
import { requireSandboxTarget } from './action-codes.js';
import { targetOf } from './target.js';
import type { Auth, UserCredential } from './types.js';

// ─── signInWithCustomToken ────────────────────────────────────────────

/**
 * `signInWithCustomToken(auth, customToken)` — mirror of `firebase/auth`.
 *
 * In production a custom token is a JWT your BACKEND signs with a service
 * account, asserting "this is user X, with these claims". The client
 * exchanges it for a session. It is the standard bridge from an existing
 * auth system into Firebase.
 *
 * The sandbox has no service-account key and no signature to verify, so
 * it treats the token as what it structurally is: a claim of identity.
 * It accepts a token in either of two shapes —
 *
 *   1. a JSON object `{"uid": "...", "claims": {...}}` (optionally
 *      base64url-encoded), which is exactly the payload
 *      `admin.auth().createCustomToken(uid, claims)` signs. This is the
 *      shape the pyric-admin mirror mints, so the two sides compose: mint
 *      on the admin side, redeem here.
 *   2. a real three-part JWT, whose middle segment is decoded and read
 *      for `uid` / `claims`. The SIGNATURE IS NOT VERIFIED — the sandbox
 *      has no key and says so rather than pretending.
 *
 * Anything else throws `auth/invalid-custom-token` — ORACLE-BACKED
 * (`auth-signinwithcustomtoken-invalid` captured exactly that code from
 * prod for both a malformed token and the empty string).
 *
 * The identity is created if it does not exist (matching prod: a custom
 * token for an unknown uid mints that account), and the credential
 * carries `providerId: null` — custom-token sign-in is not a federated
 * provider, the same rule anonymous sign-in follows.
 */
export async function signInWithCustomToken(
  auth: Auth,
  customToken: string,
): Promise<UserCredential> {
  const t = targetOf(auth);
  const target = t;
  const payload = decodeCustomToken(customToken);
  if (!payload) {
    throw makeAuthError(
      'auth/invalid-custom-token',
      'The custom token format is incorrect. Please check the documentation.',
    );
  }

  const existing = target.backend.findByUid(payload.uid);
  const isNewUser = existing === undefined;
  if (existing) {
    // A custom token re-asserts claims on every exchange — prod merges the
    // token's claims into the session, so a claims change on the backend
    // takes effect at the next sign-in without touching the user record.
    if (payload.claims) {
      target.backend.updateUser(payload.uid, { customClaims: payload.claims });
    }
  } else {
    target.backend.createUser({
      uid: payload.uid,
      ...(payload.claims ? { customClaims: payload.claims } : {}),
    });
  }
  const stored = target.backend.findByUid(payload.uid);
  if (!stored) {
    throw makeAuthError('auth/invalid-custom-token', 'signInWithCustomToken: could not materialize the identity.');
  }
  target.backend.assertSignInAllowed(stored.uid);
  const user = target.backend.buildUserFromStored(stored);
  await target.backend.transitionCurrentUser(user, 'custom');
  return {
    user,
    providerId: null,
    operationType: 'signIn',
    _additionalUserInfo: { isNewUser, profile: {}, providerId: null },
  };
}

/** Read `{uid, claims}` out of a custom token, or `null` if it carries
 *  neither shape the sandbox accepts (see {@link signInWithCustomToken}). */
function decodeCustomToken(
  token: string,
): { uid: string; claims?: Record<string, unknown> } | null {
  if (typeof token !== 'string' || token.length === 0) return null;

  // Shape 2: a real JWT — read the payload segment. The signature is NOT
  // checked; the sandbox has no key.
  const parts = token.split('.');
  const candidates = parts.length === 3 ? [parts[1] as string] : [token];

  for (const candidate of candidates) {
    const obj = tryJson(candidate) ?? tryJson(tryBase64Url(candidate));
    if (!obj) continue;
    // `uid` is admin-SDK-speak; `sub` is the JWT standard. Accept either.
    const uid = obj['uid'] ?? obj['sub'];
    if (typeof uid !== 'string' || uid.length === 0) continue;
    const rawClaims = obj['claims'];
    const claims =
      typeof rawClaims === 'object' && rawClaims !== null
        ? (rawClaims as Record<string, unknown>)
        : undefined;
    return claims ? { uid, claims } : { uid };
  }
  return null;
}

function tryJson(s: string | null): Record<string, unknown> | null {
  if (s === null) return null;
  try {
    const parsed: unknown = JSON.parse(s);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function tryBase64Url(s: string): string | null {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    return atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
  } catch {
    return null;
  }
}

// ─── revokeAccessToken ────────────────────────────────────────────────

/**
 * `revokeAccessToken(auth, token)` — mirror of `firebase/auth`.
 *
 * In production this tells the IDENTITY PROVIDER (in practice: Apple) to
 * revoke an OAuth access token — a call that leaves Firebase entirely and
 * lands on Apple's servers. It exists because Apple requires an app that
 * offers "Sign in with Apple" to also offer account deletion that revokes
 * the token.
 *
 * There is no external IdP behind a sandbox sign-in, so there is no token
 * out there to revoke and nothing this call could truthfully do. It is an
 * ACCEPTED NO-OP: it resolves, so the account-deletion flow an app must
 * ship runs end to end against the sandbox, and it changes no sandbox
 * state, because claiming otherwise would be a lie. `diverged-documented`.
 */
export async function revokeAccessToken(auth: Auth, token: string): Promise<void> {
  requireSandboxTarget(auth, 'revokeAccessToken');
  void token;
}
