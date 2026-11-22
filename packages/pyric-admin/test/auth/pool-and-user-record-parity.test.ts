/**
 * Regression and production-observation parity tests for:
 * - #1951: pyric-admin in-process and remote arms share one project user pool
 *   with client Auth (including modular FirebaseApp client handles, forced
 *   claims refresh propagation, and pre-client revocation/verification checks).
 * - #1955: pyric-admin UserRecord and UserMetadata field shapes match
 *   production captures (`freshPasswordUserRecord`, `userRecordAfterSignIn`)
 *   and firebase-admin/auth across both arms.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { UserRecord as UpstreamUserRecord } from 'firebase-admin/auth';
import { createAppForSandbox } from 'pyric/app/internal';
import {
  createUserWithEmailAndPassword,
  deleteUser,
  getAuth as getClientAuth,
  reload,
  sandbox as clientAuthSandbox,
  signInAnonymously,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  updateEmail,
  updateProfile,
} from 'pyric/auth';
import { initializeSandbox, type Sandbox } from 'pyric/sandbox';
import { getClock, idTokenAudience, mintIdToken, SANDBOX_PROJECT_ID } from 'pyric/sandbox/internal';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getAuth, type Auth } from '../../src/auth/index.js';
import { createWorkerBridgeRemoteAuth } from './worker-bridge-helper.js';

interface AuthPerSignInObservation {
  behavior: {
    admin: {
      freshPasswordUserRecord: {
        creationTime: string;
        customClaims: Record<string, unknown> | null;
        lastRefreshTime: string | null;
        lastSignInTime: string;
        providerData: string[];
        tenantId: string | null;
      };
      userRecordAfterSignIn: {
        lastRefreshTime: string;
        lastSignInTime: string;
      };
    };
  };
}

interface ClaimsPropagationObservation {
  behavior: {
    updateOk: boolean;
    claimBefore: string | null;
    claimUnforcedAfterAdminWrite: string | null;
    claimForcedRefresh: string | null;
  };
}

const AUTH_PER_SIGN_IN = JSON.parse(
  readFileSync(
    new URL(
      '../../../conformance/observations/auth/auth-request-auth-per-sign-in.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as AuthPerSignInObservation;

const CLAIMS_PROPAGATION = JSON.parse(
  readFileSync(
    new URL(
      '../../../conformance/observations/auth/auth-claims-forced-refresh-propagation.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as ClaimsPropagationObservation;

function timeFormat(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) {
    return 'toUTCString';
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return 'toISOString';
  }
  return `other: ${value.length} chars`;
}

interface TestArm {
  readonly label: 'local' | 'remote';
  readonly sandbox: Sandbox;
  readonly adminAuth: Auth;
  readonly dispose: () => void;
}

async function openArms(prefix: string): Promise<TestArm[]> {
  const localSandbox = initializeSandbox();
  const localApp = initializeApp({ sandbox: localSandbox }, `${prefix}-local`);
  const remoteStack = await createWorkerBridgeRemoteAuth(`${prefix}-remote`);
  return [
    {
      label: 'local',
      sandbox: localSandbox,
      adminAuth: getAuth(localApp),
      dispose: () => {
        localSandbox.dispose();
      },
    },
    {
      label: 'remote',
      sandbox: remoteStack.sandbox,
      adminAuth: remoteStack.auth,
      dispose: () => {
        remoteStack.dispose();
      },
    },
  ];
}

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('pyric-admin UserRecord and UserMetadata parity (#1955)', () => {
  it('matches freshPasswordUserRecord and userRecordAfterSignIn observations across local and remote arms', async () => {
    const arms = await openArms('obs-user-record');
    try {
      for (const arm of arms) {
        const createdAtMs = Date.UTC(2026, 5, 1, 10, 0, 0);
        const signedInAtMs = Date.UTC(2026, 5, 1, 10, 5, 0);
        const refreshedAtMs = Date.UTC(2026, 5, 1, 10, 12, 0);
        getClock(arm.sandbox).set(createdAtMs);

        const uid = `u-${arm.label}-obs`;
        const email = `${uid}@example.com`;
        const created = await arm.adminAuth.createUser({
          uid,
          email,
          password: 'secret-password',
        });
        const fresh = await arm.adminAuth.getUser(uid);
        const listed = await arm.adminAuth.listUsers();
        const listedHit = listed.users.find((entry) => entry.uid === uid);
        expect(listedHit).toBeDefined();
        if (listedHit === undefined) {
          throw new Error(`Expected ${uid} in listUsers on ${arm.label} arm`);
        }

        const expectedCreatedUtc = new Date(createdAtMs).toUTCString();
        for (const record of [created, fresh, listedHit]) {
          expect(
            {
              creationTime: timeFormat(record.metadata.creationTime),
              lastSignInTime: timeFormat(record.metadata.lastSignInTime),
              lastRefreshTime: record.metadata.lastRefreshTime ?? null,
              providerData: record.providerData.map((p) => p.providerId),
              tenantId: record.tenantId ?? null,
              customClaims: record.customClaims ?? null,
            },
            `${arm.label}: freshPasswordUserRecord`,
          ).toEqual(AUTH_PER_SIGN_IN.behavior.admin.freshPasswordUserRecord);

          expect(record.metadata.creationTime).toBe(expectedCreatedUtc);
          expect(record.metadata.lastSignInTime).toBeNull();
          expect(record.metadata.lastRefreshTime).toBeNull();
          expect(record.metadata.toJSON()).toEqual({
            creationTime: expectedCreatedUtc,
            lastSignInTime: null,
            lastRefreshTime: null,
          });
          expect(record.providerData[0]?.uid).toBe(email);
          expect(record.providerData[0]?.email).toBe(email);
        }

        // Sign in through the client SDK and verify both sign-in and refresh UTC timestamps.
        getClock(arm.sandbox).set(signedInAtMs);
        const clientAuth = getClientAuth(arm.sandbox);
        const { user } = await signInWithEmailAndPassword(clientAuth, email, 'secret-password');
        await user.getIdToken();

        const afterSignIn = await arm.adminAuth.getUser(uid);
        const expectedSignInUtc = new Date(signedInAtMs).toUTCString();
        expect(
          {
            lastSignInTime: timeFormat(afterSignIn.metadata.lastSignInTime),
            lastRefreshTime: timeFormat(afterSignIn.metadata.lastRefreshTime),
          },
          `${arm.label}: userRecordAfterSignIn`,
        ).toEqual(AUTH_PER_SIGN_IN.behavior.admin.userRecordAfterSignIn);
        expect(afterSignIn.metadata.creationTime).toBe(expectedCreatedUtc);
        expect(afterSignIn.metadata.lastSignInTime).toBe(expectedSignInUtc);
        expect(afterSignIn.metadata.lastRefreshTime).toBe(expectedSignInUtc);
        expect(afterSignIn.metadata.toJSON()).toEqual({
          creationTime: expectedCreatedUtc,
          lastSignInTime: expectedSignInUtc,
          lastRefreshTime: expectedSignInUtc,
        });

        // Cached getIdToken(false) and reload(user) do not advance lastRefreshTime or lastSignInTime.
        getClock(arm.sandbox).set(Date.UTC(2026, 5, 1, 10, 8, 0));
        await user.getIdToken(false);
        await reload(user);
        const afterUnforcedRead = await arm.adminAuth.getUser(uid);
        expect(afterUnforcedRead.metadata.lastSignInTime).toBe(expectedSignInUtc);
        expect(afterUnforcedRead.metadata.lastRefreshTime).toBe(expectedSignInUtc);

        // Forced token refresh advances lastRefreshTime without moving lastSignInTime.
        getClock(arm.sandbox).set(refreshedAtMs);
        await user.getIdToken(true);
        const afterRefresh = await arm.adminAuth.getUser(uid);
        const expectedRefreshUtc = new Date(refreshedAtMs).toUTCString();
        expect(afterRefresh.metadata.creationTime).toBe(expectedCreatedUtc);
        expect(afterRefresh.metadata.lastSignInTime).toBe(expectedSignInUtc);
        expect(afterRefresh.metadata.lastRefreshTime).toBe(expectedRefreshUtc);
        expect(afterRefresh.metadata.toJSON()).toEqual({
          creationTime: expectedCreatedUtc,
          lastSignInTime: expectedSignInUtc,
          lastRefreshTime: expectedRefreshUtc,
        });
      }
    } finally {
      for (const arm of arms) {
        arm.dispose();
      }
    }
  });

  it('matches firebase-admin UserMetadata runtime keys and preserves tenantId and seeded timestamps on both arms', async () => {
    const UpstreamUserRecordCtor = UpstreamUserRecord as unknown as new (
      response: Record<string, unknown>,
    ) => {
      metadata: {
        creationTime: string;
        lastSignInTime: string | null;
        lastRefreshTime: string | null;
        toJSON(): Record<string, unknown>;
      };
    };
    const createdAtMs = Date.UTC(2026, 5, 1, 12, 0, 0);
    const upstreamFresh = new UpstreamUserRecordCtor({
      localId: 'upstream-u1',
      email: 'upstream-u1@example.com',
      createdAt: String(createdAtMs),
      providerUserInfo: [
        { providerId: 'password', rawId: 'upstream-u1@example.com', email: 'upstream-u1@example.com' },
      ],
    });

    const arms = await openArms('upstream-metadata-match');
    try {
      for (const arm of arms) {
        getClock(arm.sandbox).set(createdAtMs);
        const created = await arm.adminAuth.createUser({
          uid: `u-${arm.label}-shape`,
          email: `u-${arm.label}-shape@example.com`,
          password: 'secret-password',
        });

        expect(Object.keys(created.metadata).sort()).toEqual(
          Object.keys(upstreamFresh.metadata).sort(),
        );
        expect(created.metadata.toJSON()).toEqual(upstreamFresh.metadata.toJSON());

        // Seed a tenanted user with lastLoginAt and confirm tenantId + UTC timestamps survive.
        const seededLoginIso = '2026-06-01T12:15:00.000Z';
        const expectedSeededLoginUtc = new Date(seededLoginIso).toUTCString();
        clientAuthSandbox.seedUsers(getClientAuth(arm.sandbox), [
          {
            uid: `u-${arm.label}-tenanted`,
            email: `tenant-${arm.label}@example.com`,
            password: 'secret-password',
            tenantId: 'tenant-blue',
            lastLoginAt: seededLoginIso,
          },
        ]);
        const tenanted = await arm.adminAuth.getUser(`u-${arm.label}-tenanted`);
        expect(tenanted.tenantId).toBe('tenant-blue');
        expect(tenanted.toJSON().tenantId).toBe('tenant-blue');
        expect(tenanted.metadata.lastSignInTime).toBe(expectedSeededLoginUtc);
        expect(tenanted.metadata.lastRefreshTime).toBe(expectedSeededLoginUtc);
      }
    } finally {
      for (const arm of arms) {
        arm.dispose();
      }
    }
  });
});

describe('pyric-admin shared project user pool with client Auth (#1951)', () => {
  it('replays auth-claims-forced-refresh-propagation across local, named client app, and remote arms', async () => {
    const arms = await openArms('shared-pool-claims');
    try {
      for (const arm of arms) {
        const clientApp = createAppForSandbox(
          arm.sandbox,
          { apiKey: 'sandbox-key', projectId: SANDBOX_PROJECT_ID },
          `named-client-${arm.label}`,
        );
        const clientAuth = getClientAuth(clientApp);

        const uid = `pool-${arm.label}-u1`;
        const email = `${uid}@example.com`;
        await arm.adminAuth.createUser({
          uid,
          email,
          password: 'secret-password',
        });

        const { user } = await signInWithEmailAndPassword(clientAuth, email, 'secret-password');
        const beforeResult = await user.getIdTokenResult(false);
        const claimBefore = (beforeResult.claims.role as string | undefined) ?? null;

        await arm.adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        const unforcedResult = await user.getIdTokenResult(false);
        const claimUnforcedAfterAdminWrite =
          (unforcedResult.claims.role as string | undefined) ?? null;

        const forcedResult = await user.getIdTokenResult(true);
        const claimForcedRefresh = (forcedResult.claims.role as string | undefined) ?? null;

        expect(
          {
            updateOk: true,
            claimBefore,
            claimUnforcedAfterAdminWrite,
            claimForcedRefresh,
          },
          `${arm.label}: auth-claims-forced-refresh-propagation`,
        ).toEqual(CLAIMS_PROPAGATION.behavior);

        const decoded = await arm.adminAuth.verifyIdToken(forcedResult.token);
        expect(decoded.uid).toBe(uid);
        expect(decoded.role).toBe('admin');

        // Admin disable and delete propagate to the named client app on forced refresh.
        await arm.adminAuth.updateUser(uid, { disabled: true });
        await expect(arm.adminAuth.verifyIdToken(forcedResult.token, true)).rejects.toMatchObject({
          code: 'auth/user-disabled',
        });
        await expect(user.getIdToken(true)).rejects.toMatchObject({
          code: 'auth/user-disabled',
        });
        expect(clientAuth.currentUser).toBeNull();
      }
    } finally {
      for (const arm of arms) {
        arm.dispose();
      }
    }
  });

  it('propagates client-created users and mutations back to pyric-admin on both arms', async () => {
    const arms = await openArms('shared-pool-reverse');
    try {
      for (const arm of arms) {
        const clientApp = createAppForSandbox(
          arm.sandbox,
          { apiKey: 'sandbox-key', projectId: SANDBOX_PROJECT_ID },
          `reverse-client-${arm.label}`,
        );
        const clientAuth = getClientAuth(clientApp);

        // 1. Client password account creation + profile/email updates visible to admin.
        const { user } = await createUserWithEmailAndPassword(
          clientAuth,
          `client-${arm.label}@example.com`,
          'secret-password',
        );
        await updateProfile(user, {
          displayName: 'Client Created',
          photoURL: 'https://example.com/client.png',
        });
        await updateEmail(user, `renamed-${arm.label}@example.com`);

        const fetched = await arm.adminAuth.getUser(user.uid);
        expect(fetched.email).toBe(`renamed-${arm.label}@example.com`);
        expect(fetched.displayName).toBe('Client Created');
        expect(fetched.photoURL).toBe('https://example.com/client.png');
        expect(fetched.providerData.map((p) => p.providerId)).toEqual(['password']);
        expect(timeFormat(fetched.metadata.lastSignInTime)).toBe('toUTCString');
        expect(timeFormat(fetched.metadata.lastRefreshTime)).toBe('toUTCString');

        const byEmail = await arm.adminAuth.getUserByEmail(`RENAMED-${arm.label}@EXAMPLE.COM`);
        expect(byEmail.uid).toBe(user.uid);

        // 2. Client deletion removes the record from the shared pool.
        await deleteUser(user);
        await expect(arm.adminAuth.getUser(user.uid)).rejects.toMatchObject({
          code: 'auth/user-not-found',
        });

        // 3. Anonymous and custom-token client sign-ins materialize in the admin pool.
        const { user: anon } = await signInAnonymously(clientAuth);
        const anonRecord = await arm.adminAuth.getUser(anon.uid);
        expect(anonRecord.uid).toBe(anon.uid);
        expect(anonRecord.providerData).toEqual([]);

        const customUid = `custom-${arm.label}-new`;
        const customToken = await arm.adminAuth.createCustomToken(customUid, { tier: 'gold' });
        await signInWithCustomToken(clientAuth, customToken);
        const customRecord = await arm.adminAuth.getUser(customUid);
        expect(customRecord.uid).toBe(customUid);
        expect(customRecord.customClaims).toBeUndefined();
        expect(timeFormat(customRecord.metadata.lastSignInTime)).toBe('toUTCString');
      }
    } finally {
      for (const arm of arms) {
        arm.dispose();
      }
    }
  });

  it('handles revokeRefreshTokens and verifyIdToken(checkRevoked) before getClientAuth(sandbox) is called', async () => {
    const sandbox = initializeSandbox();
    try {
      const adminAuth = getAuth(initializeApp({ sandbox }, 'pre-client-revoke'));

      await expect(adminAuth.revokeRefreshTokens('missing-before-client')).rejects.toMatchObject({
        code: 'auth/user-not-found',
      });

      const nowSec = Math.floor(getClock(sandbox).now() / 1000);
      const token = mintIdToken({
        ...idTokenAudience(SANDBOX_PROJECT_ID),
        sub: 'missing-before-client',
        user_id: 'missing-before-client',
        iat: nowSec,
        auth_time: nowSec,
        exp: nowSec + 3600,
        firebase: { identities: {}, sign_in_provider: 'password' },
      });
      await expect(adminAuth.verifyIdToken(token, true)).rejects.toMatchObject({
        code: 'auth/user-not-found',
      });
    } finally {
      sandbox.dispose();
    }
  });
});
