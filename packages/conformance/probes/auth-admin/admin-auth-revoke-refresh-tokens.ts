import type { Probe } from '../../rigs/types.ts';
import { resolveProbeWebConfig, withAdminAuthProbeSession } from '../../src/sdk-probe-runtime.ts';

interface AsyncAuthOutcome {
  threw: boolean;
  code: string | null;
  uidMatches?: boolean;
}

export interface RevokeRefreshTokensSubject {
  createUser(uid: string): Promise<void>;
  createCustomToken(uid: string): Promise<string>;
  getUser(uid: string): Promise<{ tokensValidAfterTime?: string }>;
  revokeRefreshTokens(uid: string): Promise<unknown>;
  verifyIdToken(
    idToken: string,
    checkRevoked?: boolean,
  ): Promise<{ uid: string; auth_time: number }>;
  signInClientWithCustomToken(customToken: string): Promise<{
    getIdToken(forceRefresh?: boolean): Promise<string>;
    dispose(): Promise<void>;
  }>;
  waitForNextUtcSecondAfter(authTimeSec: number): Promise<void>;
}

async function captureAsyncAuthOutcome(
  operation: () => Promise<{ uid: string } | unknown>,
  expectedUid?: string,
): Promise<AsyncAuthOutcome> {
  try {
    const resolved = await operation();
    if (expectedUid !== undefined) {
      const uid = (resolved as { uid?: unknown } | null)?.uid;
      return {
        threw: false,
        code: null,
        uidMatches: uid === expectedUid,
      };
    }
    return {
      threw: false,
      code: null,
    };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    let resolvedCode: string | null = null;
    if (typeof code === 'string') {
      resolvedCode = code;
    }
    return {
      threw: true,
      code: resolvedCode,
    };
  }
}

async function waitUntilPastUtcSecond(authTimeSec: number): Promise<void> {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    if (Math.floor(Date.now() / 1000) > authTimeSec) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

export async function observeRevokeRefreshTokens(
  subject: RevokeRefreshTokensSubject,
  uidPrefix: string,
): Promise<Record<string, unknown>> {
  const uid = `${uidPrefix}-revoke`;
  const missingUid = `${uidPrefix}-missing`;
  await subject.createUser(uid);

  const firstSession = await subject.signInClientWithCustomToken(
    await subject.createCustomToken(uid),
  );
  let secondSession: Awaited<ReturnType<RevokeRefreshTokensSubject['signInClientWithCustomToken']>> | null =
    null;

  try {
    const tokenBeforeRevoke = await firstSession.getIdToken(false);
    const decodedBefore = await subject.verifyIdToken(tokenBeforeRevoke);
    await subject.waitForNextUtcSecondAfter(decodedBefore.auth_time);

    const revokeResult = await subject.revokeRefreshTokens(uid);
    const returnsUndefined = revokeResult === undefined;

    const afterUser = await subject.getUser(uid);
    const tokensValidAfterTimeIsString = typeof afterUser.tokensValidAfterTime === 'string';
    let validSinceMs = NaN;
    if (typeof afterUser.tokensValidAfterTime === 'string') {
      validSinceMs = Date.parse(afterUser.tokensValidAfterTime);
    }
    const validSinceStrictlyAfterPriorAuthTime = validSinceMs > decodedBefore.auth_time * 1000;

    const verifyOmittedCheckRevoked = await captureAsyncAuthOutcome(
      () => subject.verifyIdToken(tokenBeforeRevoke),
      uid,
    );
    const verifyFalseCheckRevoked = await captureAsyncAuthOutcome(
      () => subject.verifyIdToken(tokenBeforeRevoke, false),
      uid,
    );
    const verifyTrueCheckRevokedPriorToken = await captureAsyncAuthOutcome(
      () => subject.verifyIdToken(tokenBeforeRevoke, true),
      uid,
    );
    const clientForceRefreshAfterRevoke = await captureAsyncAuthOutcome(() =>
      firstSession.getIdToken(true),
    );

    secondSession = await subject.signInClientWithCustomToken(
      await subject.createCustomToken(uid),
    );
    const tokenAfterRevoke = await secondSession.getIdToken(false);
    const verifyTrueCheckRevokedFreshToken = await captureAsyncAuthOutcome(
      () => subject.verifyIdToken(tokenAfterRevoke, true),
      uid,
    );

    const revokeMissingUser = await captureAsyncAuthOutcome(() =>
      subject.revokeRefreshTokens(missingUid),
    );

    return {
      returnsUndefined,
      tokensValidAfterTimeIsString,
      validSinceStrictlyAfterPriorAuthTime,
      verifyOmittedCheckRevoked,
      verifyFalseCheckRevoked,
      verifyTrueCheckRevokedPriorToken,
      clientForceRefreshAfterRevoke,
      verifyTrueCheckRevokedFreshToken,
      revokeMissingUser,
    };
  } finally {
    await firstSession.dispose();
    if (secondSession !== null) {
      await secondSession.dispose();
    }
  }
}

export const probe: Probe = {
  rig: 'admin-auth',
  requires: ['admin-auth', 'web-config'],
  matrixRow: 'auth-admin#4',
  rowIds: ['auth-admin#3a', 'auth-admin#4'],
  description:
    'firebase-admin/auth revokeRefreshTokens(uid) advances UserRecord.tokensValidAfterTime so prior ID tokens still pass verifyIdToken(token) and verifyIdToken(token, false) while rejecting verifyIdToken(token, true) with auth/id-token-revoked, forced client getIdToken(true) rejects with auth/user-token-expired, newly minted sessions pass verifyIdToken(token, true), and unknown UIDs reject with auth/user-not-found.',
  async observe(): Promise<Record<string, unknown>> {
    return withAdminAuthProbeSession(
      async ({ runId, uidPrefix, adminAuth, serviceAccount, createProbeUser }) => {
        const [{ deleteApp, initializeApp }, clientAuthMod] = await Promise.all([
          import('firebase/app'),
          import('firebase/auth'),
        ]);
        const webConfig = await resolveProbeWebConfig(serviceAccount);
        let clientSeq = 0;

        const subject: RevokeRefreshTokensSubject = {
          async createUser(uid: string): Promise<void> {
            await createProbeUser({ uid });
          },
          async createCustomToken(uid: string): Promise<string> {
            return adminAuth.createCustomToken(uid);
          },
          async getUser(uid: string): Promise<{ tokensValidAfterTime?: string }> {
            const record = await adminAuth.getUser(uid);
            return { tokensValidAfterTime: record.tokensValidAfterTime };
          },
          async revokeRefreshTokens(uid: string): Promise<unknown> {
            return adminAuth.revokeRefreshTokens(uid);
          },
          async verifyIdToken(
            idToken: string,
            checkRevoked?: boolean,
          ): Promise<{ uid: string; auth_time: number }> {
            return adminAuth.verifyIdToken(idToken, checkRevoked);
          },
          async signInClientWithCustomToken(customToken: string) {
            clientSeq += 1;
            const app = initializeApp(webConfig, `admin-auth-revoke-client-${runId}-${clientSeq}`);
            const clientAuth = clientAuthMod.getAuth(app);
            await clientAuth.setPersistence(clientAuthMod.inMemoryPersistence);
            const cred = await clientAuthMod.signInWithCustomToken(clientAuth, customToken);
            return {
              async getIdToken(forceRefresh = false): Promise<string> {
                return cred.user.getIdToken(forceRefresh);
              },
              async dispose(): Promise<void> {
                await deleteApp(app).catch(() => undefined);
              },
            };
          },
          waitForNextUtcSecondAfter: waitUntilPastUtcSecond,
        };

        return observeRevokeRefreshTokens(subject, uidPrefix);
      },
    );
  },
};
