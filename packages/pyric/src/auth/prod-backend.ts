/**
 * Prod backend — thin wrappers around `firebase/auth` so the
 * dispatch in `index.ts` stays a one-line `target.kind === 'prod'`
 * branch.
 *
 * Most calls are direct passthrough; the wrappers exist to:
 *   1. Adapt return shapes from upstream `User` (richer fields,
 *      `getIdToken` returning a string Promise) to our subset
 *      {@link User} interface.
 *   2. Translate observer args into the exact shape upstream
 *      expects (we accept both `(user) => void` and `{ next, error }`
 *      forms; upstream does too — passthrough works).
 *
 * No state lives here — the upstream `fb.Auth` is the source of
 * truth for prod targets.
 */

import * as fb from 'firebase/auth';

import { makeAuthError } from './sandbox-backend.js';
import type { ProdTarget } from './target.js';
import {
  USER_INTERNAL,
  type AuthObserver,
  type IdTokenResult,
  type Unsubscribe,
  type User,
  type UserCredential,
} from './types.js';

/**
 * Memoize the adapted {@link User} per upstream `fb.User`. Upstream's
 * `auth.currentUser` is a stored field reassigned once per sign-in
 * (`core/auth/auth_impl.ts:98,792`), so repeat reads return the SAME
 * object. Our adapter must preserve that: without this WeakMap,
 * `adaptUser` minted a fresh wrapper per call and
 * `auth.currentUser === auth.currentUser` was false — breaking the
 * `===` identity checks consumer code relies on (e.g. memo deps,
 * `cred.user === auth.currentUser`). Keyed on the upstream user so a
 * sign-out / new sign-in (new `fb.User`) correctly yields a fresh
 * wrapper. WeakMap so stale users GC cleanly.
 */
const adaptedUsers = new WeakMap<fb.User, User>();

/**
 * Adapt an upstream `fb.User` to our subset {@link User} interface.
 * The upstream user already has every field we expose plus more.
 * Memoized (see {@link adaptedUsers}) so reference equality holds
 * across re-reads, matching upstream's stored-`currentUser` semantics.
 */
function adaptUser(u: fb.User, auth: fb.Auth): User {
  const cached = adaptedUsers.get(u);
  if (cached) return cached;
  const adapted: User = {
    uid: u.uid,
    email: u.email,
    // Pass the real profile fields THROUGH rather than stripping them —
    // previously the adapter dropped photoURL / emailVerified /
    // phoneNumber / providerData / providerId, so drop-in code that read
    // them broke even against prod (AUTH-GAP).
    emailVerified: u.emailVerified,
    displayName: u.displayName,
    photoURL: u.photoURL,
    phoneNumber: u.phoneNumber,
    isAnonymous: u.isAnonymous,
    providerId: u.providerId,
    providerData: u.providerData.map((p) => ({
      uid: p.uid,
      displayName: p.displayName,
      email: p.email,
      phoneNumber: p.phoneNumber,
      photoURL: p.photoURL,
      providerId: p.providerId,
    })),
    getIdToken: (forceRefresh?: boolean) => u.getIdToken(forceRefresh),
    getIdTokenResult: async (forceRefresh?: boolean): Promise<IdTokenResult> => {
      const r = await u.getIdTokenResult(forceRefresh);
      return {
        token: r.token,
        claims: r.claims,
        expirationTime: r.expirationTime,
        issuedAtTime: r.issuedAtTime,
        authTime: r.authTime,
      };
    },
  };
  // Stamp the backend-dispatch hook non-enumerably so the top-level
  // `updateProfile(user, …)` free function delegates to the real
  // `firebase/auth.updateProfile` on the closed-over upstream user.
  Object.defineProperty(adapted, USER_INTERNAL, {
    value: {
      updateProfile: (p: { displayName?: string | null; photoURL?: string | null }) =>
        fb.updateProfile(u, p),
      delete: () => fb.deleteUser(u),
      updateEmail: (newEmail: string) => fb.updateEmail(u, newEmail),
      updatePassword: (newPassword: string) => fb.updatePassword(u, newPassword),
      reload: () => fb.reload(u),
      raw: u,
      // Routing rides on the user (see UserInternal.target) — this one
      // came from prod, and `u.auth` is the upstream handle it belongs to.
      target: { kind: 'prod', auth } satisfies ProdTarget,
    },
    enumerable: false,
  });
  adaptedUsers.set(u, adapted);
  return adapted;
}

export function prodCurrentUser(auth: fb.Auth): User | null {
  return auth.currentUser ? adaptUser(auth.currentUser, auth) : null;
}

function adaptCredential(c: fb.UserCredential, auth: fb.Auth): UserCredential {
  return {
    user: adaptUser(c.user, auth),
    providerId: c.providerId,
    operationType: c.operationType as UserCredential['operationType'],
  };
}

export async function prodSignInAnonymously(auth: fb.Auth): Promise<UserCredential> {
  return adaptCredential(await fb.signInAnonymously(auth), auth);
}

export async function prodSignInWithEmailAndPassword(
  auth: fb.Auth,
  email: string,
  password: string,
): Promise<UserCredential> {
  return adaptCredential(await fb.signInWithEmailAndPassword(auth, email, password), auth);
}

export async function prodCreateUserWithEmailAndPassword(
  auth: fb.Auth,
  email: string,
  password: string,
): Promise<UserCredential> {
  return adaptCredential(await fb.createUserWithEmailAndPassword(auth, email, password), auth);
}

export async function prodSignOut(auth: fb.Auth): Promise<void> {
  return fb.signOut(auth);
}

export async function prodSignInWithPopup(
  auth: fb.Auth,
  provider: { providerId: string },
): Promise<UserCredential> {
  // Cast: upstream `AuthProvider` is a more specific shape; we accept
  // anything with a providerId at our boundary and pass it through.
  return adaptCredential(await fb.signInWithPopup(auth, provider as fb.AuthProvider), auth);
}

export async function prodSignInWithRedirect(
  auth: fb.Auth,
  provider: { providerId: string },
): Promise<void> {
  // Navigates away in a real browser; the credential surfaces on return
  // via `getRedirectResult`. Same cast rationale as `prodSignInWithPopup`.
  return fb.signInWithRedirect(auth, provider as fb.AuthProvider);
}

export async function prodGetRedirectResult(auth: fb.Auth): Promise<UserCredential | null> {
  const cred = await fb.getRedirectResult(auth);
  return cred ? adaptCredential(cred, auth) : null;
}

export async function prodSignInWithCredential(
  auth: fb.Auth,
  credential: { providerId: string },
): Promise<UserCredential> {
  // Note: real `signInWithCredential` takes a proper `AuthCredential`
  // (constructed via `*.credential(...)`). Our public `AuthCredential`
  // is a structural marker — for prod targets, the caller is
  // expected to pass an actual upstream credential object that we
  // re-cast here. The pyric API surface accepts both because the
  // sandbox doesn't care about credential internals.
  return adaptCredential(await fb.signInWithCredential(auth, toFbCredential(credential)), auth);
}

export function prodOnAuthStateChanged(auth: fb.Auth, observer: AuthObserver): Unsubscribe {
  // Upstream accepts the same `NextOrObserver` shape. We need to
  // re-wrap so the user our consumer sees is the adapted shape.
  if (typeof observer === 'function') {
    return fb.onAuthStateChanged(auth, (u) => observer(u ? adaptUser(u, auth) : null));
  }
  return fb.onAuthStateChanged(auth, {
    next: (u) => observer.next?.(u ? adaptUser(u, auth) : null),
    error: (e) => observer.error?.(e),
    complete: () => observer.complete?.(),
  });
}

export function prodOnIdTokenChanged(auth: fb.Auth, observer: AuthObserver): Unsubscribe {
  if (typeof observer === 'function') {
    return fb.onIdTokenChanged(auth, (u) => observer(u ? adaptUser(u, auth) : null));
  }
  return fb.onIdTokenChanged(auth, {
    next: (u) => observer.next?.(u ? adaptUser(u, auth) : null),
    error: (e) => observer.error?.(e),
    complete: () => observer.complete?.(),
  });
}

export function prodBeforeAuthStateChanged(
  auth: fb.Auth,
  callback: (user: User | null) => void | Promise<void>,
  onAbort?: () => void,
): Unsubscribe {
  // Upstream's callback also takes the adapted-shape user; re-wrap the
  // same way `prodOnAuthStateChanged` does so the callback sees our
  // subset `User`, not the raw `fb.User`.
  return fb.beforeAuthStateChanged(auth, (u) => callback(u ? adaptUser(u, auth) : null), onAbort);
}

export async function prodSetPersistence(auth: fb.Auth, persistence: { type: string }): Promise<void> {
  // Map our marker to the upstream singleton. Upstream's
  // `inMemoryPersistence` / `browserSessionPersistence` /
  // `browserLocalPersistence` are the three options.
  let p: fb.Persistence;
  switch (persistence.type) {
    case 'NONE': p = fb.inMemoryPersistence; break;
    case 'SESSION': p = fb.browserSessionPersistence; break;
    case 'LOCAL': p = fb.browserLocalPersistence; break;
    default:
      // An unrecognized marker is a programming error — prod rejects an
      // invalid persistence argument with `auth/argument-error` rather
      // than silently coercing it to LOCAL (AUTH-B12).
      throw makeAuthError(
        'auth/argument-error',
        `setPersistence failed: unsupported persistence type "${persistence.type}". `
          + 'Use inMemoryPersistence, browserSessionPersistence, or browserLocalPersistence.',
      );
  }
  return fb.setPersistence(auth, p);
}

// ─── Credential bridge ────────────────────────────────────────────────

/**
 * Convert a pyric {@link AuthCredential} into the real upstream credential
 * `firebase/auth` requires.
 *
 * This bridge is what keeps the product's central promise honest for the
 * linking / reauth families: code written against the sandbox with
 * `EmailAuthProvider.credential(email, password)` must run UNCHANGED
 * against prod. It can, because the pyric credential carries the same
 * secret the upstream factory wants — so we can rebuild the genuine
 * article rather than casting a marker and hoping.
 *
 * A credential that is already an upstream one (a caller who imported
 * from `firebase/auth` directly) passes straight through.
 */
function toFbCredential(credential: { providerId: string; signInMethod?: string }): fb.AuthCredential {
  if (credential instanceof fb.AuthCredential) return credential;

  const c = credential as {
    providerId: string;
    signInMethod?: string;
    email?: string;
    password?: string | null;
    emailLink?: string | null;
    idToken?: string;
    accessToken?: string;
    secret?: string;
  };

  if (c.providerId === 'password' && typeof c.email === 'string') {
    if (typeof c.emailLink === 'string' && c.emailLink) {
      return fb.EmailAuthProvider.credentialWithLink(c.email, c.emailLink);
    }
    if (typeof c.password === 'string') {
      return fb.EmailAuthProvider.credential(c.email, c.password);
    }
  }
  if (c.idToken !== undefined || c.accessToken !== undefined) {
    return new fb.OAuthProvider(c.providerId).credential({
      idToken: c.idToken,
      accessToken: c.accessToken,
    });
  }
  // Nothing we can faithfully rebuild — hand it through as upstream did
  // before this bridge existed, so behavior is no worse than it was.
  return credential as unknown as fb.AuthCredential;
}

// ─── Prod delegates: the email / linking / reauth families ────────────
//
// Each of these is a straight passthrough to `firebase/auth`, recovering
// the upstream `fb.User` from the adapter's USER_INTERNAL `raw` hook where
// the API is user-scoped. They exist so agent code written against the
// sandbox runs unmodified against prod — the whole point of the mirror.

/** Recover the upstream `fb.User` an adapted user wraps, plus the
 *  `fb.Auth` it belongs to. Both ride on the USER_INTERNAL hook (`raw`
 *  and `target`) — `fb.User` does not publicly expose its own auth, which
 *  is exactly why the hook carries the target. */
function rawUser(user: User, api: string): { raw: fb.User; auth: fb.Auth } {
  const internal = (user as { [USER_INTERNAL]?: { raw: unknown; target?: { kind: string; auth?: fb.Auth } } })[USER_INTERNAL];
  const raw = internal?.raw;
  const auth = internal?.target?.kind === 'prod' ? internal.target.auth : undefined;
  if (!raw || !auth) {
    throw makeAuthError(
      'auth/invalid-user-token',
      `${api}: unrecognized user — was it produced by a pyric/auth sign-in?`,
    );
  }
  return { raw: raw as fb.User, auth };
}

export async function prodSendEmailVerification(user: User, settings?: unknown): Promise<void> {
  return fb.sendEmailVerification(rawUser(user, 'sendEmailVerification').raw, settings as fb.ActionCodeSettings);
}

export async function prodVerifyBeforeUpdateEmail(
  user: User,
  newEmail: string,
  settings?: unknown,
): Promise<void> {
  return fb.verifyBeforeUpdateEmail(
    rawUser(user, 'verifyBeforeUpdateEmail').raw,
    newEmail,
    settings as fb.ActionCodeSettings,
  );
}

export async function prodSendPasswordResetEmail(
  auth: fb.Auth,
  email: string,
  settings?: unknown,
): Promise<void> {
  return fb.sendPasswordResetEmail(auth, email, settings as fb.ActionCodeSettings);
}

export async function prodSendSignInLinkToEmail(
  auth: fb.Auth,
  email: string,
  settings: unknown,
): Promise<void> {
  return fb.sendSignInLinkToEmail(auth, email, settings as fb.ActionCodeSettings);
}

export function prodIsSignInWithEmailLink(auth: fb.Auth, link: string): boolean {
  return fb.isSignInWithEmailLink(auth, link);
}

export async function prodSignInWithEmailLink(
  auth: fb.Auth,
  email: string,
  link: string,
): Promise<UserCredential> {
  return adaptCredential(await fb.signInWithEmailLink(auth, email, link), auth);
}

export async function prodApplyActionCode(auth: fb.Auth, code: string): Promise<void> {
  return fb.applyActionCode(auth, code);
}

export async function prodCheckActionCode(auth: fb.Auth, code: string): Promise<unknown> {
  return fb.checkActionCode(auth, code);
}

export async function prodVerifyPasswordResetCode(auth: fb.Auth, code: string): Promise<string> {
  return fb.verifyPasswordResetCode(auth, code);
}

export async function prodConfirmPasswordReset(
  auth: fb.Auth,
  code: string,
  newPassword: string,
): Promise<void> {
  return fb.confirmPasswordReset(auth, code, newPassword);
}

export async function prodLinkWithCredential(
  user: User,
  credential: { providerId: string },
): Promise<UserCredential> {
  const { raw, auth } = rawUser(user, 'linkWithCredential');
  return adaptCredential(await fb.linkWithCredential(raw, toFbCredential(credential)), auth);
}

export async function prodLinkWithPopup(
  user: User,
  provider: { providerId: string },
): Promise<UserCredential> {
  const { raw, auth } = rawUser(user, 'linkWithPopup');
  return adaptCredential(await fb.linkWithPopup(raw, provider as fb.AuthProvider), auth);
}

export async function prodLinkWithRedirect(
  user: User,
  provider: { providerId: string },
): Promise<void> {
  return fb.linkWithRedirect(rawUser(user, 'linkWithRedirect').raw, provider as fb.AuthProvider);
}

export async function prodUnlink(user: User, providerId: string): Promise<User> {
  const { raw, auth } = rawUser(user, 'unlink');
  const updated = await fb.unlink(raw, providerId);
  return adaptUser(updated, auth);
}

export async function prodReauthenticateWithCredential(
  user: User,
  credential: { providerId: string },
): Promise<UserCredential> {
  const { raw, auth } = rawUser(user, 'reauthenticateWithCredential');
  return adaptCredential(await fb.reauthenticateWithCredential(raw, toFbCredential(credential)), auth);
}

export async function prodReauthenticateWithPopup(
  user: User,
  provider: { providerId: string },
): Promise<UserCredential> {
  const { raw, auth } = rawUser(user, 'reauthenticateWithPopup');
  return adaptCredential(await fb.reauthenticateWithPopup(raw, provider as fb.AuthProvider), auth);
}

export async function prodReauthenticateWithRedirect(
  user: User,
  provider: { providerId: string },
): Promise<void> {
  return fb.reauthenticateWithRedirect(rawUser(user, 'reauthenticateWithRedirect').raw, provider as fb.AuthProvider);
}

export async function prodSignInWithCustomToken(
  auth: fb.Auth,
  customToken: string,
): Promise<UserCredential> {
  return adaptCredential(await fb.signInWithCustomToken(auth, customToken), auth);
}

export async function prodValidatePassword(auth: fb.Auth, password: string): Promise<unknown> {
  return fb.validatePassword(auth, password);
}

export async function prodRevokeAccessToken(auth: fb.Auth, token: string): Promise<void> {
  return fb.revokeAccessToken(auth, token);
}
