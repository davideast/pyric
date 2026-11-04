/**
 * Token-scoped operations: `signInWithCustomToken` (sign in FROM a token)
 * and `revokeAccessToken` (revoke a provider's token), plus
 * `validatePassword` (the project password policy).
 */

import { makeAuthError } from './auth-errors.js';
import { requireSandboxTarget } from './action-codes.js';
import { getClock, mintCustomToken, readCustomToken, type SandboxCustomToken } from 'pyric/sandbox/internal';
import { targetOf, type SandboxTarget } from './target.js';
import type { Auth, User, UserCredential } from './types.js';

// ─── signInWithCustomToken ────────────────────────────────────────────

/**
 * `signInWithCustomToken(auth, customToken)` — mirror of `firebase/auth`.
 *
 * In production a custom token is a JWT your BACKEND signs with a service
 * account, asserting "this is user X, with these claims". The client
 * exchanges it for a session. It is the standard bridge from an existing
 * auth system into Firebase.
 *
 * pyric-admin `createCustomToken` and the CLI mint the token in
 * firebase-admin's shape, signed by the sandbox (`pyric/sandbox/internal`
 * `mintCustomToken`), so a server mints and the client redeems here (#1952).
 * A JWT for the custom token audience is checked:
 *
 *   - an edited signature, a missing `uid`, or an `exp` on or before the
 *     sandbox clock's now throws `auth/invalid-custom-token`, the code
 *     the client SDK maps the server's `INVALID_CUSTOM_TOKEN` to;
 *   - a token whose issuer names another project throws
 *     `auth/custom-token-mismatch` (server `CREDENTIAL_MISMATCH`).
 *
 * A token signed with a real service account key fails that check: the
 * sandbox has no key to verify it with.
 *
 * Two older unsigned shapes are still read, unchecked, for compatibility: a
 * JSON object `{"uid": "...", "claims": {...}}`, optionally base64url
 * encoded, and a three-part JWT for any other audience, whose middle segment
 * carries `uid` or `sub` and `claims`.
 *
 * Anything else throws `auth/invalid-custom-token`, ORACLE-BACKED
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
  const { user, isNewUser } = resolveCustomTokenIdentity(auth, customToken);
  await targetOf(auth).backend.transitionCurrentUser(user, 'custom');
  return { user, providerId: null, operationType: 'signIn',
    _additionalUserInfo: { isNewUser, profile: {}, providerId: null } };
}

/** Resolve a custom-token account without changing the backend's global session. */
export function resolveCustomTokenIdentity(auth: Auth, customToken: string): { user: User; isNewUser: boolean } {
  const target = targetOf(auth);
  const payload = exchangeCustomToken(target, customToken);

  const existing = target.backend.findByUid(payload.uid);
  const isNewUser = existing === undefined;
  const hasExistingUser = !isNewUser;
  const hasClaims = payload.claims !== undefined;
  if (hasExistingUser) {
    // A custom token re-asserts claims on every exchange — prod merges the
    // token's claims into the session, so a claims change on the backend
    // takes effect at the next sign-in without touching the user record.
    if (hasClaims) {
      target.backend.updateUser(payload.uid, { customClaims: payload.claims });
    }
  } else {
    const identity = hasClaims ? { uid: payload.uid, customClaims: payload.claims } : { uid: payload.uid };
    target.backend.createUser(identity);
  }
  const stored = target.backend.findByUid(payload.uid);
  const missingIdentity = stored === undefined;
  if (missingIdentity) {
    throw makeAuthError('auth/invalid-custom-token', 'signInWithCustomToken: could not materialize the identity.');
  }
  target.backend.assertSignInAllowed(stored.uid);
  const user = target.backend.buildUserFromStored(stored);
  return { user, isNewUser };
}

type CustomTokenPayload = { uid: string; claims?: Record<string, unknown> };

function invalidCustomToken(): Error {
  return makeAuthError('auth/invalid-custom-token', 'The custom token format is incorrect. Please check the documentation.');
}

/** A signed custom token's subject and claims, after its project and expiry pass. */
function checkedSignedToken(target: SandboxTarget, token: SandboxCustomToken): CustomTokenPayload {
  const isOtherProject = token.projectId !== target.backend.tokenProjectId();
  if (isOtherProject) {
    throw makeAuthError('auth/custom-token-mismatch', 'The custom token corresponds to a different audience.');
  }
  const nowSec = Math.floor(getClock(target.sandbox).now() / 1000);
  const hasExpired = nowSec >= token.exp;
  if (hasExpired) throw invalidCustomToken();
  return token.claims ? { uid: token.uid, claims: token.claims } : { uid: token.uid };
}

/** The `{uid, claims}` a custom token asserts, or the error production answers it with. */
function exchangeCustomToken(target: SandboxTarget, token: string): CustomTokenPayload {
  const reading = typeof token === 'string' ? readCustomToken(token) : { kind: 'invalid' as const };
  if (reading.kind === 'invalid') throw invalidCustomToken();
  if (reading.kind === 'signed') return checkedSignedToken(target, reading);
  const legacy = decodeCustomToken(token);
  if (legacy === null) throw invalidCustomToken();
  return legacy;
}

/**
 * Mint the custom token {@link signInWithCustomToken} redeems for this Auth's
 * project, at the sandbox clock's now, for callers that hold the client Auth
 * rather than an admin app, such as the CLI's tools.
 */
export function mintCustomTokenFor(auth: Auth, uid: string, claims?: Record<string, unknown>): string {
  const target = targetOf(auth);
  return mintCustomToken({
    uid, claims, projectId: target.backend.tokenProjectId(), nowMs: getClock(target.sandbox).now(),
  });
}

/** Read `{uid, claims}` out of an older unsigned custom token, or `null`
 *  if it carries neither shape (see {@link signInWithCustomToken}). */
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
