/**
 * SharedWorker host — auth helpers extracted from `host-auth.ts` to keep
 * modules well under the `< 600` line ceiling (`docs/code-conventions.md`).
 */

import {
  sandbox as authSandboxOps,
  type Auth,
  type MintedSession,
  type User,
} from 'pyric/auth';
import { serializeUser } from '../protocol.js';

/**
 * Synthetic password seeded for bridged provider identities (popup/redirect).
 * Provider users never authenticate with a password — this just satisfies the
 * SeedUser shape. Matches `ServeAuthHelper`'s in-page constant in spirit.
 */
export const PROVIDER_SYNTHETIC_PASSWORD = '__pyric_popup_no_password__';

/**
 * The `photoUrl` a bridged provider identity should be seeded with.
 *
 * A provider sign-in refreshes the stored photo when the identity carries one,
 * and leaves it alone when it does not — the same rule the in-page backend's
 * `recordProviderSignIn` applies. `seedUsers` replaces the whole record, so an
 * identity with no photo has to carry the stored value forward here or the
 * re-seed would blank a photo an earlier sign-in established.
 */
export function seedPhotoUrl(
  auth: Auth,
  uid: string,
  identityPhotoURL: string | null,
): string | undefined {
  if (identityPhotoURL !== null) return identityPhotoURL;
  const stored = authSandboxOps.listUsers(auth).find((user) => user.uid === uid);
  if (!stored?.photoUrl) return undefined;
  return stored.photoUrl;
}

/** Serialized UserCredential reply shape for a minted session. */
export function credReply(session: MintedSession, providerId: string | null) {
  return {
    user: serializeUser(session.user),
    providerId,
    operationType: 'signIn' as const,
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

/** The port session's User, or throw `auth/no-current-user`. */
export function requireSessionUser(session: MintedSession | null, api: string): User {
  return requirePortSession(session, api).user;
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
  credential: {
    providerId: string;
    idToken?: string | null;
    accessToken?: string | null;
    rawNonce?: string | null;
    email?: string | null;
    displayName?: string | null;
    photoURL?: string | null;
    uid?: string | null;
  },
): string {
  authSandboxOps.assertAuthProviderEnabled(auth, credential.providerId);
  const existingUsers = authSandboxOps.listUsers(auth);
  let targetUid = credential.uid ?? null;
  if (!targetUid && credential.email) {
    const byEmail = existingUsers.find((u) => u.email === credential.email);
    if (byEmail) targetUid = byEmail.uid;
  }
  if (!targetUid) {
    const fallbackId = credential.idToken ?? credential.accessToken ?? credential.email ?? 'user';
    targetUid = `oauth-${credential.providerId}-${fallbackId}`;
  }

  const existing = existingUsers.find((u) => u.uid === targetUid);
  if (existing) {
    const providers = existing.providerUserInfo ?? [];
    const hasProvider = providers.some((p) => p.providerId === credential.providerId);
    const nextProviders = hasProvider
      ? [...providers]
      : [...providers, { providerId: credential.providerId }];
    authSandboxOps.updateUser(auth, targetUid, {
      displayName: credential.displayName ?? existing.displayName,
      email: credential.email ?? existing.email ?? undefined,
      providerUserInfo: nextProviders,
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
      providerUserInfo: [{ providerId: credential.providerId }],
    });
  }
  return targetUid;
}
