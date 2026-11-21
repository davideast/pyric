import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintCustomToken } from 'pyric/sandbox/internal';
import { REPO_ROOT } from '../../src/ledger.ts';
import { createObservationGate } from '../../src/observation-gate.ts';
import { openHostedKotlinBridge } from './kotlin-hosted-bridge-harness.ts';

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

interface AuthKotlinEmailPasswordLifecycleObservation {
  createdUidNonBlank: boolean;
  createdEmailMatchesInput: boolean;
  createdIsAnonymous: boolean;
  createdIsEmailVerified: boolean;
  createdIsNewUser: boolean;
  createdProviderId: string;
  createdProviderDataIds: string[];
  createdSignInProvider: string;
  signedOutBetweenSignIns: boolean;
  signedInSameUid: boolean;
  signedInIsNewUser: boolean;
  emailCredentialProvider: string;
  credentialSignInSameUid: boolean;
  currentUserNullAfterDelete: boolean;
}

interface AuthKotlinProfileReloadAndListenersObservation {
  initialAuthStateEvents: boolean[];
  initialIdTokenEvents: boolean[];
  authStateIncreasedOnSignIn: boolean;
  idTokenIncreasedOnSignIn: boolean;
  requestDisplayName: string;
  requestPhotoUri: string;
  displayNameAfterUpdate: string;
  photoUrlAfterUpdate: string;
  displayNameAfterReload: string;
  photoUrlAfterReload: string;
  sameUidAfterReload: boolean;
  cachedTokenNonBlank: boolean;
  forcedTokenNonBlank: boolean;
  hasExpirationTimestamp: boolean;
  hasIssuedAtTimestamp: boolean;
  authStateUnchangedOnForceRefresh: boolean;
  idTokenIncreasedOnForceRefresh: boolean;
  noEventsAfterRemoveListeners: boolean;
}

interface AuthErrorFailureOutcome {
  threw: boolean;
  exceptionClass: string;
  errorCode: string;
}

interface AuthKotlinErrorCodesAndExceptionsObservation {
  invalidEmail: AuthErrorFailureOutcome;
  weakPassword: AuthErrorFailureOutcome;
  duplicateEmail: AuthErrorFailureOutcome;
  wrongPassword: AuthErrorFailureOutcome;
  missingUser: AuthErrorFailureOutcome;
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

const KT_FIREBASE_USER_PATH = join(
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
  'FirebaseUser.kt',
);

const KT_PROFILE_REQUEST_PATH = join(
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
  'UserProfileChangeRequest.kt',
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
  test('auth-kotlin#8 auth-kotlin#9 auth-kotlin#10 auth-kotlin#20 auth-kotlin#22 auth-kotlin#23 replay BridgeAuthOperations anonymous session, currentUser, providerId, providerData, and signOut RPCs', async () => {
    const obs = gate.load<AuthKotlinAnonymousAndCustomTokenObservation>(
      'auth-kotlin-anonymous-and-custom-token-session',
    );
    const harness = await openHostedKotlinBridge({ projectId: `demo-kt-anon-${Date.now()}` });
    try {
      const initialCurrent = await harness.sendOp({ method: 'auth.getCurrentUser' });
      expect(initialCurrent.ok).toBe(true);
      expect(initialCurrent.value === null).toBe(obs.initialCurrentUserNull);

      const anonRes = await harness.sendOp({ method: 'auth.signInAnonymously' });
      expect(anonRes.ok).toBe(true);
      const anonPayload = anonRes.value as {
        user: {
          uid: string;
          isAnonymous: boolean;
          providerId?: string;
          providerData?: Array<{ providerId?: string }>;
        };
      };
      expect(anonPayload.user.uid.length).toBeGreaterThan(0);
      expect(anonPayload.user.isAnonymous).toBe(obs.anonymousIsAnonymous);

      let resolvedProviderId = 'firebase';
      if (typeof anonPayload.user.providerId === 'string' && anonPayload.user.providerId !== '') {
        resolvedProviderId = anonPayload.user.providerId;
      }
      expect(resolvedProviderId).toBe(obs.anonymousProviderId);

      const wireAnonProviders: string[] = [];
      if (Array.isArray(anonPayload.user.providerData)) {
        for (const entry of anonPayload.user.providerData) {
          if (typeof entry.providerId === 'string' && entry.providerId !== 'firebase') {
            wireAnonProviders.push(entry.providerId);
          }
        }
      }
      expect(['firebase', ...wireAnonProviders]).toEqual(obs.anonymousProviderDataIds);

      const ktUserSource = readFileSync(KT_FIREBASE_USER_PATH, 'utf8');
      expect(ktUserSource).toContain('private fun buildMasterFirebaseUserInfo(): UserInfo');
      expect(ktUserSource).toContain('return listOf(buildMasterFirebaseUserInfo()) + mapped');

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
    const harness = await openHostedKotlinBridge({ projectId });
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
      expect(ktAuthSource).toContain('FirebaseAuthInvalidCredentialsException(code, msg, e)');

      const ktLiveHostSuiteSource = readFileSync(KT_LIVE_HOST_AUTH_TEST_PATH, 'utf8');
      expect(ktLiveHostSuiteSource).toContain(
        `assertEquals("${obs.invalidCustomTokenErrorCode}", invalidCause.errorCode)`,
      );
    } finally {
      await harness.close();
    }
  });

  test('auth-kotlin#2 auth-kotlin#6 auth-kotlin#7 auth-kotlin#15 auth-kotlin#16 auth-kotlin#21 auth-kotlin#23 auth-kotlin#30 replay email/password account creation, providerData, sign-in, AdditionalUserInfo.isNewUser, and delete lifecycle', async () => {
    const obs = gate.load<AuthKotlinEmailPasswordLifecycleObservation>(
      'auth-kotlin-email-password-lifecycle',
    );
    const harness = await openHostedKotlinBridge({ projectId: `demo-kt-email-${Date.now()}` });
    try {
      const email = 'pilot@example.com';
      const password = 'CorrectHorseBattery!9';

      const createdRes = await harness.sendOp({
        method: 'auth.createUser',
        email,
        password,
      });
      expect(createdRes.ok).toBe(true);
      const createdPayload = createdRes.value as {
        user: {
          uid: string;
          email: string;
          isAnonymous: boolean;
          emailVerified: boolean;
          providerId?: string;
          providerData?: Array<{ providerId?: string }>;
        };
        additionalUserInfo?: { isNewUser?: boolean };
      };
      const createdUid = createdPayload.user.uid;
      expect(createdUid.length > 0).toBe(obs.createdUidNonBlank);
      expect(createdPayload.user.email === email).toBe(obs.createdEmailMatchesInput);
      expect(createdPayload.user.isAnonymous).toBe(obs.createdIsAnonymous);
      expect(createdPayload.user.emailVerified).toBe(obs.createdIsEmailVerified);
      expect(createdPayload.additionalUserInfo?.isNewUser).toBe(obs.createdIsNewUser);

      let resolvedProviderId = 'firebase';
      if (
        typeof createdPayload.user.providerId === 'string' &&
        createdPayload.user.providerId !== ''
      ) {
        resolvedProviderId = createdPayload.user.providerId;
      }
      expect(resolvedProviderId).toBe(obs.createdProviderId);

      const wireCreatedProviders: string[] = [];
      if (Array.isArray(createdPayload.user.providerData)) {
        for (const entry of createdPayload.user.providerData) {
          if (typeof entry.providerId === 'string' && entry.providerId !== 'firebase') {
            wireCreatedProviders.push(entry.providerId);
          }
        }
      }
      expect(['firebase', ...wireCreatedProviders]).toEqual(obs.createdProviderDataIds);

      const ktLiveHostSuiteSource = readFileSync(KT_LIVE_HOST_AUTH_TEST_PATH, 'utf8');
      expect(ktLiveHostSuiteSource).toContain(
        'assertEquals(listOf("firebase", "password"), emailUser.providerData.map { it.providerId })',
      );
      expect(ktLiveHostSuiteSource).toContain(
        'assertEquals(listOf("firebase"), anonUser.providerData.map { it.providerId })',
      );

      const createdTokenRes = await harness.sendOp({
        method: 'auth.getIdTokenResult',
        forceRefresh: false,
      });
      expect(createdTokenRes.ok).toBe(true);
      const createdToken = createdTokenRes.value as { signInProvider: string };
      expect(createdToken.signInProvider).toBe(obs.createdSignInProvider);

      expect((await harness.sendOp({ method: 'auth.signOut' })).ok).toBe(true);
      const betweenRes = await harness.sendOp({ method: 'auth.getCurrentUser' });
      expect(betweenRes.value === null).toBe(obs.signedOutBetweenSignIns);

      const signInRes = await harness.sendOp({
        method: 'auth.signInEmail',
        email,
        password,
      });
      expect(signInRes.ok).toBe(true);
      const signInPayload = signInRes.value as {
        user: { uid: string };
        additionalUserInfo?: { isNewUser?: boolean };
      };
      expect(signInPayload.user.uid === createdUid).toBe(obs.signedInSameUid);
      expect(signInPayload.additionalUserInfo?.isNewUser).toBe(obs.signedInIsNewUser);

      expect((await harness.sendOp({ method: 'auth.signOut' })).ok).toBe(true);
      const credRes = await harness.sendOp({
        method: 'auth.signInWithCredential',
        credential: {
          providerId: obs.emailCredentialProvider,
          signInMethod: obs.emailCredentialProvider,
          email,
          password,
        },
      });
      expect(credRes.ok).toBe(true);
      const credPayload = credRes.value as { user: { uid: string } };
      expect(credPayload.user.uid === createdUid).toBe(obs.credentialSignInSameUid);

      const deleteRes = await harness.sendOp({ method: 'auth.deleteUser' });
      expect(deleteRes.ok).toBe(true);
      const afterDelete = await harness.sendOp({ method: 'auth.getCurrentUser' });
      expect(afterDelete.value === null).toBe(obs.currentUserNullAfterDelete);
    } finally {
      await harness.close();
    }
  });

  test('auth-kotlin#13 auth-kotlin#14 auth-kotlin#17 auth-kotlin#18 auth-kotlin#25 auth-kotlin#27 auth-kotlin#28 auth-kotlin#29 replay updateProfile, reload, forced getIdToken, and AuthState/IdToken listener transitions', async () => {
    const obs = gate.load<AuthKotlinProfileReloadAndListenersObservation>(
      'auth-kotlin-profile-reload-and-listeners',
    );
    const harness = await openHostedKotlinBridge({ projectId: `demo-kt-profile-${Date.now()}` });
    try {
      const authStateEvents: boolean[] = [];
      const idTokenEvents: boolean[] = [];

      harness.subscribe('sub-auth-state', { target: 'authState' }, (val) => {
        authStateEvents.push(val !== null);
      });
      harness.subscribe('sub-id-token', { target: 'idToken' }, (val) => {
        idTokenEvents.push(val !== null);
      });

      await new Promise<void>((resolveTick) => setTimeout(resolveTick, 30));
      expect(authStateEvents).toEqual(obs.initialAuthStateEvents);
      expect(idTokenEvents).toEqual(obs.initialIdTokenEvents);
      const initialAuthLen = authStateEvents.length;
      const initialTokenLen = idTokenEvents.length;

      const signInRes = await harness.sendOp({ method: 'auth.signInAnonymously' });
      expect(signInRes.ok).toBe(true);
      const initialUid = (signInRes.value as { user: { uid: string } }).user.uid;
      await new Promise<void>((resolveTick) => setTimeout(resolveTick, 30));

      expect(authStateEvents.length > initialAuthLen).toBe(obs.authStateIncreasedOnSignIn);
      expect(idTokenEvents.length > initialTokenLen).toBe(obs.idTokenIncreasedOnSignIn);

      const ktProfileBuilderSource = readFileSync(KT_PROFILE_REQUEST_PATH, 'utf8');
      expect(ktProfileBuilderSource).toContain('fun setDisplayName(displayName: String?): Builder');
      expect(ktProfileBuilderSource).toContain('fun setPhotoUri(uri: URI?): Builder');

      const updateRes = await harness.sendOp({
        method: 'auth.updateProfile',
        displayName: obs.requestDisplayName,
        photoURL: obs.requestPhotoUri,
      });
      expect(updateRes.ok).toBe(true);
      const updatedUser = updateRes.value as { displayName: string; photoURL: string };
      expect(updatedUser.displayName).toBe(obs.displayNameAfterUpdate);
      expect(updatedUser.photoURL).toBe(obs.photoUrlAfterUpdate);

      const reloadRes = await harness.sendOp({ method: 'auth.reload', uid: initialUid });
      expect(reloadRes.ok).toBe(true);
      const currentAfterReload = await harness.sendOp({ method: 'auth.getCurrentUser' });
      const reloadedUser = currentAfterReload.value as {
        uid: string;
        displayName: string;
        photoURL: string;
      };
      expect(reloadedUser.displayName).toBe(obs.displayNameAfterReload);
      expect(reloadedUser.photoURL).toBe(obs.photoUrlAfterReload);
      expect(reloadedUser.uid === initialUid).toBe(obs.sameUidAfterReload);

      const cachedRes = await harness.sendOp({
        method: 'auth.getIdTokenResult',
        forceRefresh: false,
      });
      expect(cachedRes.ok).toBe(true);
      const cachedPayload = cachedRes.value as { token: string };
      expect(cachedPayload.token.length > 0).toBe(obs.cachedTokenNonBlank);

      const authBeforeForce = authStateEvents.length;
      const tokenBeforeForce = idTokenEvents.length;
      const forcedRes = await harness.sendOp({
        method: 'auth.getIdTokenResult',
        forceRefresh: true,
      });
      expect(forcedRes.ok).toBe(true);
      await new Promise<void>((resolveTick) => setTimeout(resolveTick, 30));
      const forcedPayload = forcedRes.value as {
        token: string;
        expirationTime: string;
        issuedAtTime: string;
      };
      expect(forcedPayload.token.length > 0).toBe(obs.forcedTokenNonBlank);
      expect(Date.parse(forcedPayload.expirationTime) > 0).toBe(obs.hasExpirationTimestamp);
      expect(Date.parse(forcedPayload.issuedAtTime) > 0).toBe(obs.hasIssuedAtTimestamp);
      expect(authStateEvents.length === authBeforeForce).toBe(
        obs.authStateUnchangedOnForceRefresh,
      );
      expect(idTokenEvents.length > tokenBeforeForce).toBe(obs.idTokenIncreasedOnForceRefresh);

      harness.unsubscribe('sub-auth-state');
      harness.unsubscribe('sub-id-token');
      const authBeforeSignOut = authStateEvents.length;
      const tokenBeforeSignOut = idTokenEvents.length;
      await harness.sendOp({ method: 'auth.signOut' });
      await new Promise<void>((resolveTick) => setTimeout(resolveTick, 30));
      expect(
        authStateEvents.length === authBeforeSignOut &&
          idTokenEvents.length === tokenBeforeSignOut,
      ).toBe(obs.noEventsAfterRemoveListeners);
    } finally {
      await harness.close();
    }
  });

  test('auth-kotlin#32 replays invalidEmail, weakPassword, duplicateEmail, wrongPassword, and missingUser errors across HostedRuntime and FirebaseAuth.wrapException', async () => {
    const obs = gate.load<AuthKotlinErrorCodesAndExceptionsObservation>(
      'auth-kotlin-error-codes-and-exceptions',
    );
    const harness = await openHostedKotlinBridge({ projectId: `demo-kt-errors-${Date.now()}` });
    try {
      const ktAuthSource = readFileSync(KT_FIREBASE_AUTH_PATH, 'utf8');

      const invalidEmailRes = await harness.sendOp({
        method: 'auth.createUser',
        email: 'not-an-email',
        password: 'StrongPassword!99',
      });
      expect(!invalidEmailRes.ok).toBe(obs.invalidEmail.threw);
      expect(invalidEmailRes.error?.code).toBe('auth/invalid-email');
      expect(ktAuthSource).toContain(
        `combined.contains("invalid-email", ignoreCase = true) -> "${obs.invalidEmail.errorCode}"`,
      );
      expect(ktAuthSource).toContain(`${obs.invalidEmail.exceptionClass}(code, msg, e)`);

      const weakPasswordRes = await harness.sendOp({
        method: 'auth.createUser',
        email: 'weak@example.com',
        password: '123',
      });
      expect(!weakPasswordRes.ok).toBe(obs.weakPassword.threw);
      expect(weakPasswordRes.error?.code).toBe('auth/weak-password');
      expect(ktAuthSource).toContain(
        `combined.contains("weak-password", ignoreCase = true) -> "${obs.weakPassword.errorCode}"`,
      );
      expect(ktAuthSource).toContain(obs.weakPassword.exceptionClass);

      expect(
        (
          await harness.sendOp({
            method: 'auth.createUser',
            email: 'dup@example.com',
            password: 'StrongPassword!99',
          })
        ).ok,
      ).toBe(true);

      const dupRes = await harness.sendOp({
        method: 'auth.createUser',
        email: 'dup@example.com',
        password: 'StrongPassword!99',
      });
      expect(!dupRes.ok).toBe(obs.duplicateEmail.threw);
      expect(dupRes.error?.code).toBe('auth/email-already-in-use');
      expect(ktAuthSource).toContain(
        `combined.contains("email-already-in-use", ignoreCase = true) -> "${obs.duplicateEmail.errorCode}"`,
      );
      expect(ktAuthSource).toContain(`${obs.duplicateEmail.exceptionClass}(code, msg, e)`);

      await harness.sendOp({ method: 'auth.signOut' });

      const wrongPassRes = await harness.sendOp({
        method: 'auth.signInEmail',
        email: 'dup@example.com',
        password: 'WrongPassword!00',
      });
      expect(!wrongPassRes.ok).toBe(obs.wrongPassword.threw);
      expect(wrongPassRes.error?.code).toBe('auth/invalid-credential');
      expect(ktAuthSource).toContain(
        `combined.contains("invalid-credential", ignoreCase = true) -> "${obs.wrongPassword.errorCode}"`,
      );
      expect(ktAuthSource).toContain(`${obs.wrongPassword.exceptionClass}(code, msg, e)`);

      const missingUserRes = await harness.sendOp({
        method: 'auth.signInEmail',
        email: 'missing@example.com',
        password: 'StrongPassword!99',
      });
      expect(!missingUserRes.ok).toBe(obs.missingUser.threw);
      expect(missingUserRes.error?.code).toBe('auth/invalid-credential');
      expect(obs.missingUser.errorCode).toBe(obs.wrongPassword.errorCode);
      expect(obs.missingUser.exceptionClass).toBe(obs.wrongPassword.exceptionClass);
    } finally {
      await harness.close();
    }
  });

  test('covers every committed non-staged auth-kotlin observation through createObservationGate', () => {
    const report = gate.report();
    expect(report.committed).toEqual([
      'auth-kotlin-anonymous-and-custom-token-session',
      'auth-kotlin-email-password-lifecycle',
      'auth-kotlin-error-codes-and-exceptions',
      'auth-kotlin-profile-reload-and-listeners',
    ]);
    expect(report.loadedButUnused).toEqual([]);
    expect(report.uncovered).toEqual([]);
  });
});
