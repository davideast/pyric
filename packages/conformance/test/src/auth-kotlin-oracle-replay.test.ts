import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintCustomToken } from 'pyric/sandbox/internal';
import { REPO_ROOT } from '../../src/ledger.ts';
import { createObservationGate } from '../../src/observation-gate.ts';
import { openHostedKotlinAuthBridge } from './kotlin-hosted-bridge-harness.ts';

interface AuthKotlinAnonymousAndCustomTokenObservation {
  initialCurrentUserNull: boolean;
  anonymousIsAnonymous: boolean;
  anonymousProviderId: string;
  anonymousProviderDataIds: string[];
  anonymousSignInProvider: string;
  customIsAnonymous: boolean;
  customSignInProvider: string;
  customRoleClaim: string;
  customTierClaimNumber: number;
  invalidCustomTokenErrorCode: string;
  signedOutCurrentUserNull: boolean;
}

const AUTH_KOTLIN_OBSERVATIONS_DIR = join(
  REPO_ROOT,
  'packages',
  'conformance',
  'observations',
  'auth-kotlin',
);

const KT_FIREBASE_AUTH_PATH = join(
  REPO_ROOT,
  'packages',
  'kt-client',
  'src',
  'main',
  'kotlin',
  'com',
  'google',
  'firebase',
  'auth',
  'FirebaseAuth.kt',
);

const KT_LIVE_HOST_AUTH_TEST_PATH = join(
  REPO_ROOT,
  'packages',
  'kt-client',
  'src',
  'test',
  'kotlin',
  'dev',
  'pyric',
  'e2e',
  'AuthLiveHostConformanceTest.kt',
);

const gate = createObservationGate({
  dir: AUTH_KOTLIN_OBSERVATIONS_DIR,
  match: (filename) => filename.startsWith('auth-kotlin-'),
});

describe('auth-kotlin Android SDK production observation replay over hosted worker bridge', () => {
  test('auth-kotlin#8 auth-kotlin#9 auth-kotlin#10 auth-kotlin#20 auth-kotlin#22 replay BridgeAuthOperations anonymous session, currentUser, providerId, and signOut RPCs', async () => {
    const obs = gate.load<AuthKotlinAnonymousAndCustomTokenObservation>(
      'auth-kotlin-anonymous-and-custom-token-session',
    );
    const harness = await openHostedKotlinAuthBridge(`demo-kt-anon-${Date.now()}`);
    try {
      const initialCurrent = await harness.sendOp({ method: 'auth.getCurrentUser' });
      expect(initialCurrent.ok).toBe(true);
      expect(initialCurrent.value === null).toBe(obs.initialCurrentUserNull);

      const anonRes = await harness.sendOp({ method: 'auth.signInAnonymously' });
      expect(anonRes.ok).toBe(true);
      const anonPayload = anonRes.value as {
        user: { uid: string; isAnonymous: boolean; providerId?: string };
      };
      expect(anonPayload.user.uid.length).toBeGreaterThan(0);
      expect(anonPayload.user.isAnonymous).toBe(obs.anonymousIsAnonymous);

      let resolvedProviderId = 'firebase';
      if (typeof anonPayload.user.providerId === 'string' && anonPayload.user.providerId !== '') {
        resolvedProviderId = anonPayload.user.providerId;
      }
      expect(resolvedProviderId).toBe(obs.anonymousProviderId);
      expect(obs.anonymousProviderDataIds).toContain('firebase');

      const currentWhileSignedIn = await harness.sendOp({ method: 'auth.getCurrentUser' });
      expect(currentWhileSignedIn.ok).toBe(true);
      expect(currentWhileSignedIn.value).not.toBeNull();

      const anonTokenRes = await harness.sendOp({
        method: 'auth.getIdTokenResult',
        forceRefresh: false,
      });
      expect(anonTokenRes.ok).toBe(true);
      const anonTokenPayload = anonTokenRes.value as { signInProvider: string };
      expect(anonTokenPayload.signInProvider).toBe(obs.anonymousSignInProvider);

      const signOutRes = await harness.sendOp({ method: 'auth.signOut' });
      expect(signOutRes.ok).toBe(true);

      const afterSignOut = await harness.sendOp({ method: 'auth.getCurrentUser' });
      expect(afterSignOut.ok).toBe(true);
      expect(afterSignOut.value === null).toBe(obs.signedOutCurrentUserNull);
    } finally {
      await harness.close();
    }
  });

  test('auth-kotlin#24 auth-kotlin#26 auth-kotlin#31 auth-kotlin#32 replay hosted custom-token claims, GetTokenResult epoch timestamps, and kt-client FirebaseAuth.wrapException mapping', async () => {
    const obs = gate.load<AuthKotlinAnonymousAndCustomTokenObservation>(
      'auth-kotlin-anonymous-and-custom-token-session',
    );
    const projectId = `demo-kt-claims-${Date.now()}`;
    const harness = await openHostedKotlinAuthBridge(projectId);
    try {
      const customToken = mintCustomToken({
        uid: 'android-replay-uid',
        claims: { role: 'tester', tier: 2 },
        projectId,
        nowMs: Date.now(),
      });

      const customRes = await harness.sendOp({
        method: 'auth.signInWithCustomToken',
        customToken,
      });
      expect(customRes.ok).toBe(true);
      const customPayload = customRes.value as {
        user: { uid: string; isAnonymous: boolean };
      };
      expect(customPayload.user.uid).toBe('android-replay-uid');
      expect(customPayload.user.isAnonymous).toBe(obs.customIsAnonymous);

      const tokenRes = await harness.sendOp({
        method: 'auth.getIdTokenResult',
        forceRefresh: false,
      });
      expect(tokenRes.ok).toBe(true);
      const tokenPayload = tokenRes.value as {
        token: string;
        signInProvider: string;
        expirationTime: string;
        authTime: string;
        issuedAtTime: string;
        claims: Record<string, unknown>;
      };
      expect(tokenPayload.token.length).toBeGreaterThan(20);
      expect(tokenPayload.signInProvider).toBe(obs.customSignInProvider);
      expect(tokenPayload.claims.role).toBe(obs.customRoleClaim);
      expect(tokenPayload.claims.tier).toBe(obs.customTierClaimNumber);

      // FirebaseUser.kt:123-125 parses GetTokenResult Long epoch-second timestamps
      // from ISO strings / numeric JWT claims (`exp`, `auth_time`, `iat`).
      expect(typeof tokenPayload.claims.exp).toBe('number');
      expect(Number(tokenPayload.claims.exp)).toBeGreaterThan(0);
      expect(typeof tokenPayload.claims.auth_time).toBe('number');
      expect(Number(tokenPayload.claims.auth_time)).toBeGreaterThan(0);
      expect(typeof tokenPayload.claims.iat).toBe('number');
      expect(Number(tokenPayload.claims.iat)).toBeGreaterThan(0);
      expect(Math.floor(Date.parse(tokenPayload.expirationTime) / 1000)).toBeGreaterThan(0);
      expect(Math.floor(Date.parse(tokenPayload.authTime) / 1000)).toBeGreaterThan(0);
      expect(Math.floor(Date.parse(tokenPayload.issuedAtTime) / 1000)).toBeGreaterThan(0);

      const invalidRes = await harness.sendOp({
        method: 'auth.signInWithCustomToken',
        customToken: 'not-a-valid-jwt',
      });
      expect(invalidRes.ok).toBe(false);
      let wireErrorCode = '';
      if (invalidRes.error !== undefined) {
        wireErrorCode = invalidRes.error.code;
      }
      expect(wireErrorCode).toBe('auth/invalid-custom-token');

      const bareSlug = wireErrorCode.replace(/^auth\//, '');
      const ktAuthSource = readFileSync(KT_FIREBASE_AUTH_PATH, 'utf8');
      expect(ktAuthSource).toContain(
        `combined.contains("${bareSlug}", ignoreCase = true) -> "${obs.invalidCustomTokenErrorCode}"`,
      );
      expect(ktAuthSource).toContain(
        `"${obs.invalidCustomTokenErrorCode}"`,
      );
      expect(ktAuthSource).toContain('FirebaseAuthInvalidCredentialsException(code, msg, e)');

      const ktLiveHostSuiteSource = readFileSync(KT_LIVE_HOST_AUTH_TEST_PATH, 'utf8');
      expect(ktLiveHostSuiteSource).toContain(
        `assertEquals("${obs.invalidCustomTokenErrorCode}", invalidCause.errorCode)`,
      );
    } finally {
      await harness.close();
    }
  });

  test('covers every committed non-staged auth-kotlin observation through createObservationGate', () => {
    const report = gate.report();
    expect(report.committed).toContain('auth-kotlin-anonymous-and-custom-token-session');
    expect(report.loadedButUnused).toEqual([]);
    expect(report.uncovered).toEqual([]);
  });
});
