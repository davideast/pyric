/** Auth observers, token accessors, and user lifecycle operations. */
import { makeAuthError } from './sandbox-backend.js';
import { targetOf } from './target.js';
import {
  USER_INTERNAL,
  type Auth,
  type AuthObserver,
  type IdTokenResult,
  type Unsubscribe,
  type User,
  type UserInternal,
} from './types.js';

export function onAuthStateChanged(auth: Auth, observer: AuthObserver): Unsubscribe {
  const target = targetOf(auth);
  const unsubscribe = target.backend.subscribe('auth-state', observer);
  const release = target.own?.(unsubscribe);
  return () => {
    release?.();
    unsubscribe();
  };
}

export function onIdTokenChanged(auth: Auth, observer: AuthObserver): Unsubscribe {
  const target = targetOf(auth);
  const unsubscribe = target.backend.subscribe('id-token', observer);
  const release = target.own?.(unsubscribe);
  return () => {
    release?.();
    unsubscribe();
  };
}

export function beforeAuthStateChanged(
  auth: Auth,
  callback: (user: User | null) => void | Promise<void>,
  onAbort?: () => void,
): Unsubscribe {
  return targetOf(auth).backend.beforeAuthStateChanged(callback, onAbort);
}

export async function getIdToken(user: User, forceRefresh?: boolean): Promise<string> {
  return user.getIdToken(forceRefresh);
}

export async function getIdTokenResult(
  user: User,
  forceRefresh?: boolean,
): Promise<IdTokenResult> {
  return user.getIdTokenResult(forceRefresh);
}

export async function updateProfile(
  user: User,
  profile: { displayName?: string | null; photoURL?: string | null },
): Promise<void> {
  return userInternal(user, 'updateProfile').updateProfile(profile);
}

export async function deleteUser(user: User): Promise<void> {
  return userInternal(user, 'deleteUser').delete();
}

export async function updateEmail(user: User, newEmail: string): Promise<void> {
  return userInternal(user, 'updateEmail').updateEmail(newEmail);
}

export async function updatePassword(user: User, newPassword: string): Promise<void> {
  return userInternal(user, 'updatePassword').updatePassword(newPassword);
}

export async function reload(user: User): Promise<void> {
  return userInternal(user, 'reload').reload();
}

export async function updateCurrentUser(auth: Auth, user: User | null): Promise<void> {
  targetOf(auth).backend.setCurrentUser(user);
}

export function useDeviceLanguage(auth: Auth): void {
  void auth;
}

function userInternal(user: User, name: string): UserInternal {
  const internal = (user as { [USER_INTERNAL]?: UserInternal })[USER_INTERNAL];
  if (!internal) {
    throw makeAuthError(
      'auth/invalid-user-token',
      `${name}: unrecognized user — was it produced by a pyric/auth sign-in?`,
    );
  }
  return internal;
}
