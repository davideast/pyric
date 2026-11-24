import type { SanitizedGoogleCollisionCaseBehavior } from '../../src/capture/auth-google-oauth/observation-writer.ts';
import {
  GOOGLE_OAUTH_TEST_MARKER_CLAIM,
  type AdminAuthDriver,
  type AdminUserSnapshot,
  type PasswordAuthDriver,
} from '../../src/capture/auth-google-oauth/session-runner.ts';

export interface StoredFakeUser {
  uid: string;
  email: string;
  password: string | null;
  emailVerified: boolean;
  providerIds: string[];
  customClaims: Record<string, unknown> | null;
  displayName: string | null;
  photoURL: string | null;
}

export function createFakeAuthEnvironment(options?: {
  initialUsers?: readonly StoredFakeUser[];
  failCleanupVerificationForUid?: string;
}) {
  const usersByUid = new Map<string, StoredFakeUser>();
  for (const initial of options?.initialUsers ?? []) {
    let copiedClaims: Record<string, unknown> | null = null;
    if (initial.customClaims) {
      copiedClaims = { ...initial.customClaims };
    }
    usersByUid.set(initial.uid, {
      ...initial,
      providerIds: [...initial.providerIds],
      customClaims: copiedClaims,
    });
  }

  let nextUidCounter = 1;
  const deletedUids: string[] = [];
  const modifiedUids: string[] = [];

  function snapshotOf(user: StoredFakeUser): AdminUserSnapshot {
    let copiedClaims: Record<string, unknown> | null = null;
    if (user.customClaims) {
      copiedClaims = { ...user.customClaims };
    }
    return {
      uid: user.uid,
      email: user.email,
      emailVerified: user.emailVerified,
      hasPasswordHash: user.password !== null,
      providerIds: [...user.providerIds],
      customClaims: copiedClaims,
      displayName: user.displayName,
      photoURL: user.photoURL,
    };
  }

  const adminAuth: AdminAuthDriver = {
    async getUserByEmail(email) {
      const normalized = email.trim().toLowerCase();
      for (const user of usersByUid.values()) {
        if (user.email.toLowerCase() === normalized) {
          return snapshotOf(user);
        }
      }
      return null;
    },
    async getUser(uid) {
      if (options?.failCleanupVerificationForUid === uid && deletedUids.includes(uid)) {
        return {
          uid,
          email: 'lingering@example.org',
          emailVerified: false,
          hasPasswordHash: true,
          providerIds: ['password'],
          customClaims: { [GOOGLE_OAUTH_TEST_MARKER_CLAIM]: true },
        };
      }
      const found = usersByUid.get(uid);
      if (!found) {
        return null;
      }
      return snapshotOf(found);
    },
    async listUsers(maxResults, pageToken) {
      const all = [...usersByUid.values()];
      let offset = 0;
      if (pageToken !== undefined) {
        offset = Number(pageToken);
      }
      const slice = all.slice(offset, offset + maxResults).map(snapshotOf);
      let nextToken: string | undefined;
      if (offset + maxResults < all.length) {
        nextToken = String(offset + maxResults);
      }
      return { users: slice, pageToken: nextToken };
    },
    async createUser(input) {
      const uid = `run-created-uid-${nextUidCounter}`;
      nextUidCounter += 1;
      const created: StoredFakeUser = {
        uid,
        email: input.email.trim().toLowerCase(),
        password: input.password,
        emailVerified: input.emailVerified,
        providerIds: ['password'],
        customClaims: null,
        displayName: 'Seeded Test User',
        photoURL: 'https://lh3.googleusercontent.com/a/fake-avatar-secret',
      };
      usersByUid.set(uid, created);
      return snapshotOf(created);
    },
    async setCustomUserClaims(uid, claims) {
      modifiedUids.push(uid);
      const found = usersByUid.get(uid);
      if (!found) {
        const err = Object.assign(new Error('No user record'), { code: 'auth/user-not-found' });
        throw err;
      }
      found.customClaims = { ...claims };
    },
    async deleteUser(uid) {
      deletedUids.push(uid);
      if (!usersByUid.has(uid)) {
        const err = Object.assign(new Error('No user record'), { code: 'auth/user-not-found' });
        throw err;
      }
      usersByUid.delete(uid);
    },
  };

  const passwordDriver: PasswordAuthDriver = {
    async signInWithPassword(email, password) {
      const normalized = email.trim().toLowerCase();
      for (const user of usersByUid.values()) {
        if (user.email === normalized) {
          if (user.password !== null && user.password === password) {
            return {
              ok: true,
              uid: user.uid,
              emailVerified: user.emailVerified,
              providerIds: [...user.providerIds],
            };
          }
          return { ok: false, errorCode: 'auth/invalid-credential' };
        }
      }
      return { ok: false, errorCode: 'auth/user-not-found' };
    },
  };

  return {
    usersByUid,
    deletedUids,
    modifiedUids,
    adminAuth,
    passwordDriver,
  };
}

export function sampleCaseBehavior(): SanitizedGoogleCollisionCaseBehavior {
  return {
    seededBaselinePasswordSignInSucceeded: true,
    seededBaselineEmailVerified: false,
    seededBaselineProviderIds: ['password'],
    popupSucceeded: true,
    popupErrorCode: null,
    credentialFromResultPresent: true,
    credentialFromErrorPresent: false,
    resolvedSameUidAsSeeded: true,
    resolvedUserEmailVerified: true,
    resolvedUserProviderIds: ['google.com'],
    resolvedTokenEmailVerifiedClaim: true,
    resolvedTokenSignInProvider: 'google.com',
    seededRecordStillExists: true,
    postAttemptAdminEmailVerified: true,
    postAttemptAdminHasPasswordHash: false,
    postAttemptAdminProviderIds: ['google.com'],
    postAttemptPasswordSignInSucceeded: false,
    postAttemptPasswordErrorCode: 'auth/invalid-credential',
  };
}
