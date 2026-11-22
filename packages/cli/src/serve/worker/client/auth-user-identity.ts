/**
 * Hidden per-`ClientUser` port and session-key metadata plus wire-identity and
 * reconciliation helpers for user-scoped worker auth operations (#1948, #1950).
 */

import { absolutePhotoUrl, realmOrigin } from 'pyric/sandbox/internal';
import type { OpMessage, SerializedUser } from '../protocol.js';
import type { ClientAuth, ClientUser } from './auth.js';
import type { ClientPort } from './handles.js';

/** Hidden per-`ClientUser` port handle so top-level user lifecycle functions
 *  can RPC without an `auth` handle in scope. Non-enumerable -- never serialized. */
const CLIENT_USER_PORT: unique symbol = Symbol('pyric.clientUser.port');

/** Hidden per-`ClientUser` worker session key (`SerializedUser.sessionKey`).
 *  Non-enumerable, like the port. */
const CLIENT_USER_SESSION_KEY: unique symbol = Symbol('pyric.clientUser.sessionKey');

const authHandlesByPort = new WeakMap<ClientPort, Set<ClientAuth>>();

export type HeldUserOp = Extract<
  OpMessage,
  {
    method:
      | 'auth.getIdToken'
      | 'auth.getIdTokenResult'
      | 'auth.updateProfile'
      | 'auth.reload'
      | 'auth.deleteUser'
      | 'auth.updateEmail'
      | 'auth.updatePassword'
      | 'auth.reauthenticateWithCredential'
      | 'auth.reauthenticateWithProvider'
      | 'auth.sendEmailVerification'
      | 'auth.verifyBeforeUpdateEmail';
  }
>;

/** Register an auth handle under its owning port for current-user reconciliation. */
export function registerPortAuthHandle(port: ClientPort, auth: ClientAuth): void {
  let registered = authHandlesByPort.get(port);
  if (registered === undefined) {
    registered = new Set<ClientAuth>();
    authHandlesByPort.set(port, registered);
  }
  registered.add(auth);
}

/** Bind the owning port and optional session key non-enumerably onto a `ClientUser`. */
export function stampClientUserMetadata(
  user: ClientUser,
  port: ClientPort,
  sessionKey: string | undefined,
): void {
  Object.defineProperty(user, CLIENT_USER_PORT, { value: port, enumerable: false });
  Object.defineProperty(user, CLIENT_USER_SESSION_KEY, {
    value: sessionKey,
    enumerable: false,
    configurable: true,
  });
}

/** Update a `ClientUser`'s worker session key when present on a wire reply. */
export function applyClientUserSessionKey(
  user: ClientUser,
  sessionKey: string | undefined,
): void {
  if (sessionKey === undefined) {
    return;
  }
  Object.defineProperty(user, CLIENT_USER_SESSION_KEY, {
    value: sessionKey,
    enumerable: false,
    configurable: true,
  });
}

/** Resolve relative avatar `photoURL` entries on a `ClientUser.providerData` array. */
export function resolveClientProviderData(
  entries: SerializedUser['providerData'],
): SerializedUser['providerData'] {
  const origin = realmOrigin();
  return entries.map((entry) => {
    const resolved = absolutePhotoUrl(entry.photoURL, origin);
    if (resolved === entry.photoURL) {
      return entry;
    }
    return { ...entry, photoURL: resolved };
  });
}

/** Copy serialized wire fields onto a live `ClientUser` without leaking `sessionKey`. */
export function applySerializedUserFields(target: ClientUser, raw: SerializedUser): ClientUser {
  const mutable = target as { -readonly [K in keyof ClientUser]: ClientUser[K] };
  mutable.email = raw.email;
  mutable.emailVerified = raw.emailVerified;
  mutable.displayName = raw.displayName;
  mutable.photoURL = absolutePhotoUrl(raw.photoURL, realmOrigin());
  mutable.phoneNumber = raw.phoneNumber;
  mutable.isAnonymous = raw.isAnonymous;
  mutable.tenantId = raw.tenantId ?? null;
  mutable.providerId = raw.providerId;
  mutable.providerData = resolveClientProviderData(raw.providerData);
  applyClientUserSessionKey(target, raw.sessionKey);
  return target;
}

/** Reconcile any `auth.currentUser` handle on `port` matching `raw`'s `(uid, tenantId)`. */
export function reconcileMatchingCurrentUsers(port: ClientPort, raw: SerializedUser): void {
  const handles = authHandlesByPort.get(port);
  if (handles === undefined) {
    return;
  }
  const targetTenant = raw.tenantId ?? null;
  for (const authHandle of handles) {
    if (
      authHandle.currentUser !== null
      && authHandle.currentUser.uid === raw.uid
      && authHandle.currentUser.tenantId === targetTenant
    ) {
      applySerializedUserFields(authHandle.currentUser, raw);
    }
  }
}

/** Update a held `ClientUser` from a wire reply and reconcile any matching `currentUser`. */
export function syncClientUserFromWire(
  port: ClientPort,
  target: ClientUser,
  raw: SerializedUser,
): ClientUser {
  applySerializedUserFields(target, raw);
  reconcileMatchingCurrentUsers(port, raw);
  return target;
}

/** The worker session key `user` carries, which a page stores to resume the
 *  session after a reload; undefined when the worker sent none. */
export function clientUserSessionKey(user: ClientUser): string | undefined {
  return (user as { [CLIENT_USER_SESSION_KEY]?: string })[CLIENT_USER_SESSION_KEY];
}

/** Retrieve the port that produced `user`, or throw `auth/invalid-user-token`. */
export function requireUserPort(user: ClientUser, api: string): ClientPort {
  const port = (user as { [CLIENT_USER_PORT]?: ClientPort })[CLIENT_USER_PORT];
  const hasNoPort = port === undefined;
  if (hasNoPort) {
    const err = new Error(
      `${api}: unrecognized user -- was it produced by a worker-path sign-in?`,
    ) as Error & { code: string };
    err.code = 'auth/invalid-user-token';
    throw err;
  }
  return port;
}

/** Attach a held `ClientUser`'s identity (`uid`, `tenantId`, optional `sessionKey`) to an op. */
export function attachHeldUserIdentity<T extends HeldUserOp>(
  user: ClientUser,
  message: T,
): T {
  message.uid = user.uid;
  message.tenantId = user.tenantId;
  const sessionKey = clientUserSessionKey(user);
  if (sessionKey !== undefined) {
    message.sessionKey = sessionKey;
  }
  return message;
}
