/**
 * Account linking: `linkWithCredential`, `linkWithPopup`,
 * `linkWithRedirect`, `unlink`.
 *
 * ─── Why this family needed a credential that carries a secret ──────
 * `linkWithCredential(user, cred)` has to answer "does this credential
 * really belong to whoever presents it, and is it free to attach?" For an
 * EMAIL credential the sandbox can answer both questions itself: the
 * secret is in the credential and the account table is right here. No
 * resolver, no mock, no external anything. That is why
 * `EmailAuthCredential` was given a real secret (see `credentials.ts`) —
 * it is what makes this family genuinely implementable rather than
 * merely stubbable.
 *
 * For an OAUTH credential the sandbox cannot answer the first question —
 * it is not Google — so `linkWithPopup` / `linkWithRedirect` go through
 * the same `AuthFlowResolver` seam `signInWithPopup` already uses, with
 * `authType: 'link'` (a value the request type has carried since the seam
 * was built, waiting for exactly this). The host resolves who the user
 * is; the sandbox does the linking.
 *
 * ─── Evidence ──────────────────────────────────────────────────────
 * HONEST STATEMENT, because it matters: the linking conflict codes here
 * are NOT oracle-backed. We wrote probes for all of them
 * (`auth-link-email-credential-to-anonymous`, `auth-link-conflicts`) and
 * ran them against the real project — and every one came back
 * `auth/operation-not-allowed`, because the oracle project currently has
 * the Email/Password sign-in provider DISABLED, so no email credential
 * can be minted there at all. The captures are committed showing exactly
 * that, rather than being quietly dropped.
 *
 * The one linking fact we DID capture cleanly is `unlink` of a provider
 * that was never linked -> `auth/no-such-provider`
 * (`auth-unlink-provider`), because that path needs no email credential.
 * Everything else in this file is unit-backed against the error codes in
 * `AuthErrorCodes` (itself oracle-captured:
 * `PROVIDER_ALREADY_LINKED = 'auth/provider-already-linked'`,
 * `CREDENTIAL_ALREADY_IN_USE = 'auth/credential-already-in-use'`), and
 * the registry rows are born unit-backed and say so.
 */

import { makeAuthError } from './auth-errors.js';
import { requireSandboxUser, userInternal } from './action-codes.js';
import { AuthCredential, EmailAuthCredential } from './credentials.js';
import type { AuthProvider } from './providers.js';
import type { SandboxTarget } from './target.js';
import type { AuthFlowRequest, AuthFlowResolver, User, UserCredential } from './types.js';

/**
 * `linkWithCredential(user, credential)` — mirror of `firebase/auth`.
 *
 * The anonymous upgrade is the flow this exists for: a user who has been
 * writing data as `anonymous-1` links an email credential and keeps the
 * SAME uid, so everything they created is still theirs. `isAnonymous`
 * flips to false; `providerData` gains the provider.
 *
 * Rejects with:
 *   - `auth/provider-already-linked` — the account already carries this
 *     provider (one identity per provider, always).
 *   - `auth/email-already-in-use` — the email credential belongs to a
 *     different account. An address can back only one identity, so the
 *     link cannot be granted without stealing it.
 *
 * Returns a `UserCredential` with `operationType: 'link'`.
 */
export async function linkWithCredential(
  user: User,
  credential: AuthCredential,
): Promise<UserCredential> {
  const t = userInternal(user, 'linkWithCredential').target;
  const target = t;
  target.backend.assertProviderEnabled(credential.providerId);

  if (credential instanceof EmailAuthCredential) {
    const password = credential.password;
    const stored = target.backend.linkProvider(user.uid, credential.providerId, {
      email: credential.email,
      // An email-LINK credential carries no password — the account is
      // linked without one, and stays passwordless until it sets one.
      password,
      // A link credential proves control of the address; a password
      // credential proves nothing about the address itself.
      emailVerified: credential.emailLink !== null ? true : undefined,
    });
    return completeLink(target, stored.uid, credential.providerId);
  }

  // OAuth (or any non-email) credential: the sandbox cannot verify the
  // IdP's token, so the identity behind it must come through the seam.
  const stored = target.backend.linkProvider(user.uid, credential.providerId);
  return completeLink(target, stored.uid, credential.providerId);
}

/**
 * `linkWithPopup(user, provider, resolver?)` — mirror of `firebase/auth`.
 *
 * Runs the SAME resolver seam as `signInWithPopup`, with
 * `authType: 'link'` so a host UI can tell the two apart and say "link
 * your Google account" rather than "sign in". The resolved credential
 * names the provider to attach; the sandbox performs the attach.
 */
export async function linkWithPopup(
  user: User,
  provider: AuthProvider,
  resolver?: AuthFlowResolver,
): Promise<UserCredential> {
  userInternal(user, 'linkWithPopup');
  return linkViaFlow(user, provider, resolver, 'popup', 'linkWithPopup');
}

/**
 * `linkWithRedirect(user, provider, resolver?)` — mirror of
 * `firebase/auth`. The sandbox has no navigation, so the resolver
 * resolves inline and the link completes immediately — the same
 * simplification `signInWithRedirect` makes, and the same observable
 * outcome a real redirect produces once it returns.
 */
export async function linkWithRedirect(
  user: User,
  provider: AuthProvider,
  resolver?: AuthFlowResolver,
): Promise<UserCredential> {
  userInternal(user, 'linkWithRedirect');
  return linkViaFlow(user, provider, resolver, 'redirect', 'linkWithRedirect');
}

/**
 * `unlink(user, providerId)` — mirror of `firebase/auth`. Detaches a
 * provider and returns the updated user.
 *
 * `auth/no-such-provider` when it was never linked — ORACLE-BACKED
 * (`auth-unlink-provider` captured exactly this code against prod).
 *
 * Unlinking the `'password'` provider takes the password with it, so
 * `signInWithEmailAndPassword` for that account stops working — which is
 * the observable point of doing it. Unlinking the LAST provider does not
 * re-anonymize the account: `isAnonymous` describes how an identity was
 * born, not what it currently carries.
 */
export async function unlink(user: User, providerId: string): Promise<User> {
  const t = userInternal(user, 'unlink').target;
  const target = t;
  const stored = target.backend.unlinkProvider(user.uid, providerId);
  const updated = target.backend.buildUserFromStored(stored);
  // The unlinked user becomes the live current user when they ARE the
  // current user — held references (auth.currentUser) must see the
  // shrunken providerData, matching prod.
  if (target.backend.getCurrentUser()?.uid === stored.uid) {
    target.backend.setCurrentUser(updated);
  }
  return updated;
}

// ─── Shared internals ─────────────────────────────────────────────────

async function linkViaFlow(
  user: User,
  provider: AuthProvider,
  perCall: AuthFlowResolver | undefined,
  kind: 'popup' | 'redirect',
  api: string,
): Promise<UserCredential> {
  const target = requireSandboxUser(user, api);
  // Gate BEFORE touching the resolver registry, so a disabled provider
  // throws `auth/operation-not-allowed` — the same ordering `resolveFlow`
  // uses for sign-in, and for the same reason: that code must stay
  // distinct from the argument-error below, which means "enabled, but
  // nothing wired to resolve it".
  target.backend.assertProviderEnabled(provider.providerId);
  const req: AuthFlowRequest = { providerId: provider.providerId, authType: 'link' };
  const resolver = perCall ?? target.backend.getResolver();
  let resolved: UserCredential | undefined;
  if (resolver) {
    resolved = kind === 'popup' ? await resolver.openPopup(req) : await resolver.openRedirect(req);
  } else {
    resolved = target.backend.consumeMockResult(provider.providerId);
  }
  if (!resolved) {
    throw makeAuthError(
      'auth/argument-error',
      `${api}(provider: ${provider.providerId}): no AuthFlowResolver configured. Inject one with sandbox.setAuthFlowResolver(auth, resolver), pass one as the resolver argument, or pre-stage a result with sandbox.mockSignInResult(auth, {user, providerId: '${provider.providerId}', …}).`,
    );
  }
  const providerId = resolved.providerId ?? provider.providerId;
  const stored = target.backend.linkProvider(user.uid, providerId);
  return completeLink(target, stored.uid, providerId);
}

/** Rebuild the linked user, make it current if it is, and shape the
 *  `UserCredential` every link path returns. */
function completeLink(
  target: SandboxTarget,
  uid: string,
  providerId: string,
): UserCredential {
  const stored = target.backend.findByUid(uid);
  if (!stored) {
    throw makeAuthError('auth/user-not-found', `link: no identity with uid ${uid} after linking.`);
  }
  const updated = target.backend.buildUserFromStored(stored);
  if (target.backend.getCurrentUser()?.uid === uid) {
    // The upgraded identity replaces the anonymous one in place. Uses
    // setCurrentUser (not transitionCurrentUser) because the UID does not
    // change: this is not a sign-in, so the beforeAuthStateChanged gate
    // must not fire and onAuthStateChanged must not re-announce a
    // "new" user. Prod agrees — a link keeps the session.
    target.backend.setCurrentUser(updated, providerId);
  }
  return {
    user: updated,
    // The credential names the provider that was attached — unlike a
    // password SIGN-IN, where providerId is null. A link is by definition
    // about a specific provider.
    providerId: providerId === 'password' ? null : providerId,
    operationType: 'link',
    _additionalUserInfo: {
      // A link never creates an identity — it attaches to one that
      // already existed.
      isNewUser: false,
      profile: {},
      providerId: providerId === 'password' ? null : providerId,
    },
  };
}
