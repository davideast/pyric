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
import { sessionKeyOf } from 'pyric/auth/internal';
import { serializeUser, type SerializedUser } from '../protocol.js';
import { FirebaseError } from 'pyric/app';

/** A session's user in wire form, with the session key a reloaded page hands back (#1950). */
export function serializeSessionUser(user: User | null): SerializedUser | null {
  return serializeUser(user, user === null ? undefined : sessionKeyOf(user));
}

/** Payload describing an OAuth credential submitted for sign-in over the bridge. */
export interface OAuthCredentialPayload {
  readonly providerId: string;
  readonly email?: string | null;
  readonly displayName?: string | null;
  readonly photoURL?: string | null;
  readonly uid?: string | null;
  readonly customClaims?: Record<string, unknown>;
  readonly tenantId?: string | null;
  /**
   * The caller's flag for a staged result: it decides a new account's
   * `emailVerified`, and an existing account keeps its own. Absent for a
   * dialog identity, whose provider decides (see `createSignInCredential`).
   */
  readonly emailVerified?: boolean;
}

/** Serialized UserCredential reply shape for a minted session. */
export function credReply(
  session: MintedSession,
  providerId: string | null,
  isNewUser: boolean = false,
) {
  return {
    user: serializeSessionUser(session.user),
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
 * never be written back to the account during refresh. The mint is a
 * refresh-token exchange, so it is refused for a disabled, deleted or revoked
 * session, and the new session keeps the held one's authentication.
 */
export function remintSessionWithClaims(auth: Auth, session: MintedSession): MintedSession {
  const providerClaim = (session.state.token?.firebase as { sign_in_provider?: string } | undefined)?.sign_in_provider;
  let kind: 'custom' | 'uid' = 'uid';
  if (providerClaim === 'custom') {
    kind = 'custom';
  }
  return authSandboxOps.mintSession(auth, {
    kind,
    uid: session.user.uid,
    tenantId: session.user.tenantId ?? null,
    from: session.user,
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
  const targetTenant = credential.tenantId ?? null;
  const existingUsers = authSandboxOps.listUsers(auth);
  let targetUid = credential.uid && credential.uid.length > 0 ? credential.uid : null;
  if (!targetUid && credential.email) {
    const lowerEmail = credential.email.toLowerCase();
    const byEmail = existingUsers.find(
      (u) => u.email?.toLowerCase() === lowerEmail && (u.tenantId ?? null) === targetTenant,
    );
    if (byEmail) targetUid = byEmail.uid;
  }
  if (!targetUid) {
    targetUid = targetTenant
      ? `oauth-${targetTenant}-${credential.providerId}-${credential.email || 'user'}`
      : `oauth-${credential.providerId}-${credential.email || 'user'}`;
  }

  const existing = existingUsers.find((u) => u.uid === targetUid);
  const callerDecidesVerification = credential.emailVerified !== undefined;
  if (existing) {
    // A caller's flag leaves an existing account's flag as stored.
    authSandboxOps.createSignInCredential(auth, {
      providerId: credential.providerId, uid: targetUid, verifyEmail: !callerDecidesVerification,
    });
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
      emailVerified: credential.emailVerified,
      ...(targetTenant !== null ? { tenantId: targetTenant } : {}),
    } as Parameters<typeof authSandboxOps.createUser>[1]);
    // Without a caller's flag, the provider sign-in, not the admin create,
    // decides what the provider vouches for, such as a new Google identity's
    // verified email.
    if (!callerDecidesVerification) {
      authSandboxOps.createSignInCredential(auth, { providerId: credential.providerId, uid: targetUid });
    }
  }
  return { uid: targetUid, isNewUser: !existing };
}
