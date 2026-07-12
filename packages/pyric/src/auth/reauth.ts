/**
 * Re-authentication: `reauthenticateWithCredential`,
 * `reauthenticateWithPopup`, `reauthenticateWithRedirect`.
 *
 * ─── What re-auth IS ───────────────────────────────────────────────
 * Proving, again and freshly, that the person at the keyboard is the
 * account owner — before a sensitive mutation (change the password,
 * change the email, delete the account). In production the point of it is
 * the `auth/requires-recent-login` gate: those mutations REFUSE to run on
 * a session whose sign-in is older than a few minutes, and re-auth is how
 * you clear the gate.
 *
 * ─── The divergence, stated up front ───────────────────────────────
 * The sandbox does NOT enforce `auth/requires-recent-login`. `updateEmail`
 * / `updatePassword` / `deleteUser` already run on a session of any age
 * (a pre-existing, documented divergence — see their COMPAT rows), so
 * there is no gate here for re-auth to clear, and inventing one would
 * break every existing sandbox flow while proving nothing. What re-auth
 * therefore DOES here is real but narrower: it genuinely re-verifies the
 * credential, mints a fresh token (a new `authTime`), and returns a
 * `UserCredential` with `operationType: 'reauthenticate'`. Code that
 * calls it runs unchanged against prod, where it also clears the gate.
 *
 * This is a divergence-documented row, not a conforming one. Saying so is
 * the whole job.
 *
 * ─── Evidence ──────────────────────────────────────────────────────
 * Not oracle-backed, and for a specific reason worth recording: the
 * probe exists (`auth-reauthenticate-with-credential`) and was run
 * against the real project, but the oracle project has the
 * Email/Password provider DISABLED, so it could not even create the two
 * accounts the probe needs — every arm came back
 * `auth/operation-not-allowed`. The capture is committed showing that.
 * The error codes below are matched to the oracle-captured
 * `AuthErrorCodes` map (`USER_MISMATCH = 'auth/user-mismatch'`), and the
 * rows are born unit-backed.
 */

import { makeAuthError } from './auth-errors.js';
import { requireSandboxUser, userInternal } from './action-codes.js';
import {
  prodReauthenticateWithCredential,
  prodReauthenticateWithPopup,
  prodReauthenticateWithRedirect,
} from './prod-backend.js';
import { AuthCredential, EmailAuthCredential } from './credentials.js';
import type { AuthProvider } from './providers.js';
import type { AuthFlowRequest, AuthFlowResolver, User, UserCredential } from './types.js';

/**
 * `reauthenticateWithCredential(user, credential)` — mirror of
 * `firebase/auth`.
 *
 * Really re-verifies: an email credential is checked against the stored
 * password exactly as `signInWithEmailAndPassword` checks it, so a wrong
 * password throws `auth/wrong-password` and a credential belonging to a
 * DIFFERENT account throws `auth/user-mismatch` (the check that stops
 * "reauthenticate as someone else" from silently succeeding).
 *
 * On success mints a fresh ID token, so `getIdTokenResult(user).authTime`
 * advances — the observable trace of a fresh sign-in, and the thing prod's
 * recent-login gate reads.
 */
export async function reauthenticateWithCredential(
  user: User,
  credential: AuthCredential,
): Promise<UserCredential> {
  const t = userInternal(user, 'reauthenticateWithCredential').target;
  if (t.kind === 'prod') return prodReauthenticateWithCredential(user, credential);
  const target = t;
  target.backend.assertProviderEnabled(credential.providerId);

  if (credential instanceof EmailAuthCredential) {
    const stored = target.backend.findByEmail(credential.email);
    // user-mismatch BEFORE the password compare: presenting another
    // account's credential is the wrong-user error regardless of whether
    // the password happens to be right, and answering "wrong password"
    // there would leak whether it was.
    if (!stored || stored.uid !== user.uid) {
      throw makeAuthError(
        'auth/user-mismatch',
        'The supplied credentials do not correspond to the previously signed in user.',
      );
    }
    const password = credential.password;
    if (password === null) {
      throw makeAuthError(
        'auth/argument-error',
        'reauthenticateWithCredential: an email-link credential carries no password to verify.',
      );
    }
    // The real check — same path signInWithEmailAndPassword takes, so it
    // throws the same `auth/wrong-password` / `auth/user-disabled`.
    target.backend.validatePassword(credential.email, password);
    return completeReauth(user, target, null);
  }

  // OAuth credential: the sandbox cannot verify an IdP token, so the only
  // honest check is that the credential's provider is actually linked to
  // this account.
  const stored = target.backend.findByUid(user.uid);
  if (!stored?.providerUserInfo.some((p) => p.providerId === credential.providerId)) {
    throw makeAuthError(
      'auth/user-mismatch',
      'The supplied credentials do not correspond to the previously signed in user.',
    );
  }
  return completeReauth(user, target, credential.providerId);
}

/**
 * `reauthenticateWithPopup(user, provider, resolver?)` — mirror of
 * `firebase/auth`. Runs the shared resolver seam with
 * `authType: 'reauth'`, so a host UI can present "confirm it's you"
 * rather than a fresh sign-in.
 *
 * The resolved credential must be for THE SAME user — a resolver that
 * hands back a different uid throws `auth/user-mismatch`. Without that
 * check, "re-authentication" would accept anyone.
 */
export async function reauthenticateWithPopup(
  user: User,
  provider: AuthProvider,
  resolver?: AuthFlowResolver,
): Promise<UserCredential> {
  const t = userInternal(user, 'reauthenticateWithPopup').target;
  if (t.kind === 'prod') return prodReauthenticateWithPopup(user, provider);
  return reauthViaFlow(user, provider, resolver, 'popup', 'reauthenticateWithPopup');
}

/**
 * `reauthenticateWithRedirect(user, provider, resolver?)` — mirror of
 * `firebase/auth`. Resolves inline (the sandbox has no navigation), same
 * as `signInWithRedirect`.
 */
export async function reauthenticateWithRedirect(
  user: User,
  provider: AuthProvider,
  resolver?: AuthFlowResolver,
): Promise<UserCredential> {
  const t = userInternal(user, 'reauthenticateWithRedirect').target;
  if (t.kind === 'prod') {
    await prodReauthenticateWithRedirect(user, provider);
    return { user, providerId: provider.providerId, operationType: 'reauthenticate' };
  }
  return reauthViaFlow(user, provider, resolver, 'redirect', 'reauthenticateWithRedirect');
}

// ─── Shared internals ─────────────────────────────────────────────────

async function reauthViaFlow(
  user: User,
  provider: AuthProvider,
  perCall: AuthFlowResolver | undefined,
  kind: 'popup' | 'redirect',
  api: string,
): Promise<UserCredential> {
  const target = requireSandboxUser(user, api);
  target.backend.assertProviderEnabled(provider.providerId);
  const req: AuthFlowRequest = { providerId: provider.providerId, authType: 'reauth' };
  const resolver = perCall ?? target.backend.getResolver();
  const resolved = resolver
    ? (kind === 'popup' ? await resolver.openPopup(req) : await resolver.openRedirect(req))
    : target.backend.consumeMockResult(provider.providerId);
  if (!resolved) {
    throw makeAuthError(
      'auth/argument-error',
      `${api}(provider: ${provider.providerId}): no AuthFlowResolver configured. Inject one with sandbox.setAuthFlowResolver(auth, resolver), pass one as the resolver argument, or pre-stage a result with sandbox.mockSignInResult(auth, {user, providerId: '${provider.providerId}', …}).`,
    );
  }
  // The identity the resolver produced must BE the user being
  // re-authenticated. This is the entire security content of the flow.
  if (resolved.user.uid !== user.uid) {
    throw makeAuthError(
      'auth/user-mismatch',
      'The supplied credentials do not correspond to the previously signed in user.',
    );
  }
  return completeReauth(user, target, resolved.providerId ?? provider.providerId);
}

/** Mint a fresh token for the re-verified user and shape the credential. */
function completeReauth(
  user: User,
  target: ReturnType<typeof requireSandboxUser>,
  providerId: string | null,
): UserCredential {
  const stored = target.backend.findByUid(user.uid);
  const claims = stored?.customClaims ?? {};
  // Force a refresh: a successful re-auth produces a NEW token with a new
  // authTime. That advance is the observable trace of the re-verification
  // (and what prod's recent-login gate reads).
  target.backend.getIdTokenResultFor(user.uid, claims, true);
  const refreshed = stored ? target.backend.buildUserFromStored(stored) : user;
  return {
    user: refreshed,
    providerId,
    operationType: 'reauthenticate',
    _additionalUserInfo: {
      isNewUser: false,
      profile: {},
      providerId,
    },
  };
}
