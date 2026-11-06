/**
 * Token-scoped operations: `signInWithCustomToken` (sign in FROM a token)
 * and `revokeAccessToken` (revoke a provider's token), plus
 * `validatePassword` (the project password policy).
 */

import { makeAuthError } from './auth-errors.js';
import { requireSandboxTarget } from './action-codes.js';
import { getClock, mintCustomToken, readCustomToken, type SandboxCustomToken } from 'pyric/sandbox/internal';
import { SandboxBackend } from './sandbox-backend.js';
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
 * Anything else throws `auth/invalid-custom-token`, as production answers
 * a token it cannot verify (#2009): the unsigned JSON `{uid, claims}` shape
 * and its base64url form, a JWT for another audience or none, and a
 * custom-token-audience JWT the sandbox did not sign. ORACLE-BACKED
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
  const isOtherProject = token.projectId !== SandboxBackend.tokenProjectId(target.backend);
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
  if (reading.kind !== 'signed') throw invalidCustomToken();
  return checkedSignedToken(target, reading);
}

/**
 * Mint the custom token {@link signInWithCustomToken} redeems for this Auth's
 * project, at the sandbox clock's now, for callers that hold the client Auth
 * rather than an admin app, such as the CLI's tools.
 */
export function mintCustomTokenFor(auth: Auth, uid: string, claims?: Record<string, unknown>): string {
  const target = targetOf(auth);
  return mintCustomToken({
    uid, claims, projectId: SandboxBackend.tokenProjectId(target.backend), nowMs: getClock(target.sandbox).now(),
  });
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
