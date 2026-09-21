/**
 * SharedWorker host — provider linking, profile mutation, and OAuth credential
 * resolution extracted from `host-auth.ts`.
 */

import {
  sandbox as authSandboxOps,
  type Auth,
  type MintedSession,
  type User,
} from 'pyric/auth';
import { serializeUser } from '../protocol.js';
import { FirebaseError } from 'pyric/app';

/** Payload describing an OAuth credential submitted for sign-in over the bridge. */
export interface OAuthCredentialPayload {
  readonly providerId: string;
  readonly idToken?: string | null;
  readonly accessToken?: string | null;
  readonly rawNonce?: string | null;
  readonly email?: string | null;
  readonly displayName?: string | null;
  readonly photoURL?: string | null;
  readonly uid?: string | null;
  readonly customClaims?: Record<string, unknown>;
}

/** Serialized UserCredential reply shape for a minted session. */
export function credReply(
  session: MintedSession,
  providerId: string | null,
  isNewUser: boolean = false,
) {
  return {
    user: serializeUser(session.user),
    providerId,
    operationType: 'signIn' as const,
    additionalUserInfo: {
      isNewUser,
      profile: {},
      providerId,
    },
  };
}

/** Build an `auth/no-current-user`-style error for token ops with no user. */
export function makeNoUserError(api: string): Error & { code: string } {
  const err = new Error(`${api}: no current user is signed in.`) as Error & { code: string };
  err.code = 'auth/no-current-user';
  return err;
}

/** Ensure a port session is present or throw `auth/no-current-user`. */
export function requirePortSession(session: MintedSession | null, api: string): MintedSession {
  if (!session) throw makeNoUserError(api);
  return session;
}

/** A held user handle may not act on a connection that has switched identities. */
export function requireMatchingPortSession(
  current: MintedSession | null,
  message: { method: string; uid: string; tenantId: string | null },
): MintedSession {
  const session = requirePortSession(current, message.method);
  const sameUser = session.user.uid === message.uid && session.user.tenantId === message.tenantId;
  const isStaleUser = !sameUser;
  if (isStaleUser) throw new FirebaseError('auth/user-mismatch', 'The user no longer owns this connection’s session.');
  return session;
}

/** The port session's User, or throw `auth/no-current-user`. */
export function requireSessionUser(session: MintedSession | null, api: string): User {
  return requirePortSession(session, api).user;
}

/**
 * Refresh a port session from the stored account while retaining its tenant.
 * Session claims may predate an admin change or checkpoint restore; they must
 * never be written back to the account during refresh.
 */
export function remintSessionWithClaims(auth: Auth, session: MintedSession): MintedSession {
  return authSandboxOps.mintSession(auth, {
    kind: 'uid',
    uid: session.user.uid,
    tenantId: session.user.tenantId ?? null,
  });
}

/**
 * Mutate a port session's `User` `displayName` / `photoURL` (and the first
 * `providerData` entry's) in place so a subsequent `auth.getCurrentUser`
 * reflects an `auth.updateProfile`. Fields are `readonly` at the type level
 * but plain data at runtime; only an explicitly-provided field is applied
 * (`null` clears, `undefined` leaves untouched).
 */
export function applyProfileToUser(
  user: User,
  profile: { displayName?: string | null; photoURL?: string | null },
): void {
  const mutable = user as { -readonly [K in keyof User]: User[K] };
  if (profile.displayName !== undefined) mutable.displayName = profile.displayName;
  if (profile.photoURL !== undefined) mutable.photoURL = profile.photoURL;
  const provider0 = user.providerData?.[0] as
    | { -readonly [K in keyof NonNullable<User['providerData']>[number]]: NonNullable<User['providerData']>[number][K] }
    | undefined;
  if (provider0) {
    if (profile.displayName !== undefined) provider0.displayName = profile.displayName;
    if (profile.photoURL !== undefined) provider0.photoURL = profile.photoURL;
  }
}

/**
 * Verify provider config and seed or update an OAuth credential user in the
 * sandbox user pool with linked `providerData` (`providerUserInfo`).
 */
export function resolveOAuthCredentialUser(
  auth: Auth,
  credential: OAuthCredentialPayload,
): { uid: string; isNewUser: boolean } {
  authSandboxOps.assertAuthProviderEnabled(auth, credential.providerId);
  const existingUsers = authSandboxOps.listUsers(auth);
  let targetUid = credential.uid ?? null;
  if (!targetUid && credential.email) {
    const byEmail = existingUsers.find((u) => u.email === credential.email);
    if (byEmail) targetUid = byEmail.uid;
  }
  if (!targetUid) {
    let fallbackId = 'user';
    if (credential.idToken) {
      fallbackId = credential.idToken;
    } else if (credential.accessToken) {
      fallbackId = credential.accessToken;
    } else if (credential.email) {
      fallbackId = credential.email;
    }
    targetUid = `oauth-${credential.providerId}-${fallbackId}`;
  }

  const existing = existingUsers.find((u) => u.uid === targetUid);
  if (existing) {
    authSandboxOps.createSignInCredential(auth, { providerId: credential.providerId, uid: targetUid });
    authSandboxOps.updateUser(auth, targetUid, {
      displayName: credential.displayName ?? existing.displayName,
      email: credential.email ?? existing.email ?? undefined,
    });
    if (credential.photoURL !== undefined) {
      authSandboxOps.updateProfile(auth, targetUid, {
        photoURL: credential.photoURL,
        displayName: credential.displayName ?? existing.displayName,
      });
    }
  } else {
    authSandboxOps.createUser(auth, {
      uid: targetUid,
      email: credential.email ?? undefined,
      displayName: credential.displayName ?? undefined,
      photoUrl: credential.photoURL ?? undefined,
      customClaims: credential.customClaims,
      providerUserInfo: [{ providerId: credential.providerId }],
    });
  }
  return { uid: targetUid, isNewUser: !existing };
}
