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
function adaptUser(u: fb.User): User {
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
    },
    enumerable: false,
  });
  adaptedUsers.set(u, adapted);
  return adapted;
}

export function prodCurrentUser(auth: fb.Auth): User | null {
  return auth.currentUser ? adaptUser(auth.currentUser) : null;
}

function adaptCredential(c: fb.UserCredential): UserCredential {
  return {
    user: adaptUser(c.user),
    providerId: c.providerId,
    operationType: c.operationType as UserCredential['operationType'],
  };
}

export async function prodSignInAnonymously(auth: fb.Auth): Promise<UserCredential> {
  return adaptCredential(await fb.signInAnonymously(auth));
}

export async function prodSignInWithEmailAndPassword(
  auth: fb.Auth,
  email: string,
  password: string,
): Promise<UserCredential> {
  return adaptCredential(await fb.signInWithEmailAndPassword(auth, email, password));
}

export async function prodCreateUserWithEmailAndPassword(
  auth: fb.Auth,
  email: string,
  password: string,
): Promise<UserCredential> {
  return adaptCredential(await fb.createUserWithEmailAndPassword(auth, email, password));
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
  return adaptCredential(await fb.signInWithPopup(auth, provider as fb.AuthProvider));
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
  return cred ? adaptCredential(cred) : null;
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
  return adaptCredential(await fb.signInWithCredential(auth, credential as unknown as fb.AuthCredential));
}

export function prodOnAuthStateChanged(auth: fb.Auth, observer: AuthObserver): Unsubscribe {
  // Upstream accepts the same `NextOrObserver` shape. We need to
  // re-wrap so the user our consumer sees is the adapted shape.
  if (typeof observer === 'function') {
    return fb.onAuthStateChanged(auth, (u) => observer(u ? adaptUser(u) : null));
  }
  return fb.onAuthStateChanged(auth, {
    next: (u) => observer.next?.(u ? adaptUser(u) : null),
    error: (e) => observer.error?.(e),
    complete: () => observer.complete?.(),
  });
}

export function prodOnIdTokenChanged(auth: fb.Auth, observer: AuthObserver): Unsubscribe {
  if (typeof observer === 'function') {
    return fb.onIdTokenChanged(auth, (u) => observer(u ? adaptUser(u) : null));
  }
  return fb.onIdTokenChanged(auth, {
    next: (u) => observer.next?.(u ? adaptUser(u) : null),
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
  return fb.beforeAuthStateChanged(auth, (u) => callback(u ? adaptUser(u) : null), onAbort);
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
