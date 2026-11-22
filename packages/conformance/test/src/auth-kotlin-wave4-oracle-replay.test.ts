import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mintCustomToken } from 'pyric/sandbox/internal';
import { createObservationGate } from '../../src/observation-gate.ts';
import {
  AUTH_KOTLIN_OBSERVATIONS_DIR,
  buildUnsignedOidcJwt,
  KT_AUTH_CREDENTIAL_PATH,
  KT_AUTH_KTX_PATH,
  KT_EMAIL_AUTH_PROVIDER_PATH,
  KT_FIREBASE_AUTH_PATH,
  KT_FIREBASE_USER_PATH,
  KT_GOOGLE_AUTH_CREDENTIAL_PATH,
  KT_GOOGLE_AUTH_PROVIDER_PATH,
  KT_LIVE_HOST_AUTH_TEST_PATH,
  KT_OAUTH_CREDENTIAL_PATH,
  KT_OAUTH_PROVIDER_PATH,
  OBSERVATION_STEM,
  summarizeKotlinProviderData,
  type AuthKotlinWave4Observation,
  type HostedUserWire,
} from './auth-kotlin-wave4-replay-support.ts';
import { openHostedKotlinBridge } from './kotlin-hosted-bridge-harness.ts';

const gate = createObservationGate({
  dir: AUTH_KOTLIN_OBSERVATIONS_DIR,
  match: (filename) => filename === `${OBSERVATION_STEM}.json`,
});

describe('Wave 4 auth-kotlin Android SDK production observation replay over hosted worker bridge', () => {
  test('auth-kotlin#1 auth-kotlin#2 auth-kotlin#3 auth-kotlin#4 replay default/named FirebaseAuth, Firebase.auth KTX, app binding, languageCode, and multi-tenant isolation', async () => {
    const obs = gate.load<AuthKotlinWave4Observation>(OBSERVATION_STEM);
    const ktAuthSource = readFileSync(KT_FIREBASE_AUTH_PATH, 'utf8');
    const ktKtxSource = readFileSync(KT_AUTH_KTX_PATH, 'utf8');
    const ktLiveHostSource = readFileSync(KT_LIVE_HOST_AUTH_TEST_PATH, 'utf8');

    expect(obs.defaultAuthSameAsFirebaseKtx).toBe(true);
    expect(obs.defaultAuthAppIsDefault).toBe(true);
    expect(obs.namedAuthSameAsFirebaseKtx).toBe(true);
    expect(obs.authAppMatchesInitializedApp).toBe(true);
    expect(obs.initialTenantIdNull).toBe(true);
    expect(obs.separateAppTenantIdNull).toBe(true);
    expect(obs.explicitLanguageCode).toBe('de');
    expect(obs.afterUseAppLanguageValid).toBe(true);

    expect(ktAuthSource).toContain(
      'fun getInstance(): FirebaseAuth = getInstance(FirebaseApp.getInstance())',
    );
    expect(ktAuthSource).toContain('fun getInstance(app: FirebaseApp): FirebaseAuth');
    expect(ktAuthSource).toContain('val app: FirebaseApp,');
    expect(ktAuthSource).toContain('var tenantId: String?');
    expect(ktAuthSource).toContain('fun setLanguageCode(languageCode: String)');
    expect(ktAuthSource).toContain('fun useAppLanguage()');
    expect(ktKtxSource).toContain('val Firebase.auth: FirebaseAuth');
    expect(ktKtxSource).toContain('get() = FirebaseAuth.getInstance()');
    expect(ktKtxSource).toContain('fun Firebase.auth(app: FirebaseApp): FirebaseAuth =');
    expect(ktLiveHostSource).toContain('assertSame(defaultAuth, Firebase.auth)');
    expect(ktLiveHostSource).toContain('assertSame(FirebaseApp.getInstance(), defaultAuth.app)');
    expect(ktLiveHostSource).toContain('assertSame(authAlpha, Firebase.auth(appAlpha))');
    expect(ktLiveHostSource).toContain('assertSame(appAlpha, authAlpha.app)');

    const projectId = `demo-kt-wave4-tenant-${Date.now()}`;
    const tenantHarness = await openHostedKotlinBridge({ projectId });
    try {
      const defaultSession = await tenantHarness.sendOp({ method: 'auth.signInAnonymously' });
      expect(defaultSession.ok).toBe(true);
      const defaultUser = (defaultSession.value as { user: HostedUserWire }).user;
      expect(defaultUser.tenantId === null).toBe(obs.initialTenantIdNull);

      expect((await tenantHarness.sendOp({ method: 'auth.signOut' })).ok).toBe(true);

      const tenantEmail = 'wave4-tenant-user@example.com';
      const tenantPassword = 'TenantWave4Password!9';
      const tenantCreate = await tenantHarness.sendOp({
        method: 'auth.createUser',
        email: tenantEmail,
        password: tenantPassword,
        tenantId: obs.configuredTenantId,
      });
      expect(tenantCreate.ok).toBe(true);
      const tenantUser = (tenantCreate.value as { user: HostedUserWire }).user;
      expect(tenantUser.tenantId).toBe(obs.configuredTenantId);

      const tokenRes = await tenantHarness.sendOp({
        method: 'auth.getIdTokenResult',
        forceRefresh: false,
      });
      expect(tokenRes.ok).toBe(true);
      const claims = (tokenRes.value as { claims: Record<string, unknown> }).claims;
      const firebaseClaim = claims['firebase'] as { tenant?: string } | undefined;
      let tenantClaim: string | undefined;
      if (firebaseClaim !== undefined) {
        tenantClaim = firebaseClaim.tenant;
      }
      expect(tenantClaim).toBe(obs.configuredTenantId);

      expect((await tenantHarness.sendOp({ method: 'auth.signOut' })).ok).toBe(true);

      const untenantSignIn = await tenantHarness.sendOp({
        method: 'auth.signInEmail',
        email: tenantEmail,
        password: tenantPassword,
      });
      expect(untenantSignIn.ok).toBe(false);

      const separateAnon = await tenantHarness.sendOp({ method: 'auth.signInAnonymously' });
      expect(separateAnon.ok).toBe(true);
      const separateUser = (separateAnon.value as { user: HostedUserWire }).user;
      expect(separateUser.tenantId === null).toBe(obs.separateAppTenantIdNull);
    } finally {
      await tenantHarness.close();
    }
  });

  test('auth-kotlin#19 auth-kotlin#23 replay FirebaseUser.phoneNumber and providerData across anonymous session, linkWithCredential, reauthenticate, updatePassword, and unlink', async () => {
    const obs = gate.load<AuthKotlinWave4Observation>(OBSERVATION_STEM);
    const ktUserSource = readFileSync(KT_FIREBASE_USER_PATH, 'utf8');
    expect(ktUserSource).toContain(
      'override val phoneNumber: String? get() = rawData["phoneNumber"] as? String',
    );
    expect(ktUserSource).toContain('private fun buildMasterFirebaseUserInfo(): UserInfo');
    expect(ktUserSource).toContain('return listOf(buildMasterFirebaseUserInfo()) + mapped');

    const projectId = `demo-kt-wave4-link-${Date.now()}`;
    const harness = await openHostedKotlinBridge({ projectId });
    try {
      const anonRes = await harness.sendOp({ method: 'auth.signInAnonymously' });
      expect(anonRes.ok).toBe(true);
      const anonUser = (anonRes.value as { user: HostedUserWire }).user;
      expect(anonUser.phoneNumber === null).toBe(obs.anonymousPhoneNumberNull);
      expect(summarizeKotlinProviderData(anonUser, null)).toEqual(obs.anonymousProviderEntries);

      const upgradeEmail = 'wave4-upgrade@example.com';
      const initialPassword = 'Wave4InitialPassword!8';
      const updatedPassword = 'Wave4UpdatedPassword!9';

      const linkRes = await harness.sendOp({
        method: 'auth.linkWithCredential',
        uid: anonUser.uid,
        tenantId: null,
        credential: {
          providerId: 'password',
          signInMethod: 'password',
          email: upgradeEmail,
          password: initialPassword,
        },
      });
      expect(linkRes.ok).toBe(true);
      const linkedUser = (linkRes.value as { user: HostedUserWire }).user;
      expect(linkedUser.uid === anonUser.uid).toBe(obs.linkPreservedUid);
      expect(linkedUser.isAnonymous).toBe(obs.linkedIsAnonymous);
      expect(linkedUser.email === upgradeEmail).toBe(obs.linkedEmailMatches);
      expect(linkedUser.phoneNumber === null).toBe(obs.linkedPhoneNumberNull);
      expect(summarizeKotlinProviderData(linkedUser, upgradeEmail)).toEqual(
        obs.linkedProviderEntries,
      );

      const reauthRes = await harness.sendOp({
        method: 'auth.reauthenticateWithCredential',
        uid: anonUser.uid,
        tenantId: null,
        credential: {
          providerId: 'password',
          signInMethod: 'password',
          email: upgradeEmail,
          password: initialPassword,
        },
      });
      expect(reauthRes.ok).toBe(true);
      const reauthUser = (reauthRes.value as { user: HostedUserWire }).user;
      expect(reauthUser.uid === anonUser.uid).toBe(obs.reauthenticatePreservedUid);

      const updatePassRes = await harness.sendOp({
        method: 'auth.updatePassword',
        password: updatedPassword,
      });
      expect(updatePassRes.ok).toBe(true);
      expect((await harness.sendOp({ method: 'auth.signOut' })).ok).toBe(true);

      const signInUpdatedRes = await harness.sendOp({
        method: 'auth.signInWithCredential',
        credential: {
          providerId: 'password',
          signInMethod: 'password',
          email: upgradeEmail,
          password: updatedPassword,
        },
      });
      expect(signInUpdatedRes.ok).toBe(true);
      const updatedUser = (signInUpdatedRes.value as { user: HostedUserWire }).user;
      expect(updatedUser.uid === anonUser.uid).toBe(obs.updatedPasswordCredentialSameUid);

      const unlinkRes = await harness.sendOp({
        method: 'auth.unlink',
        uid: anonUser.uid,
        tenantId: null,
        providerId: 'password',
      });
      expect(unlinkRes.ok).toBe(true);
      const unlinkedUser = unlinkRes.value as HostedUserWire;
      const unlinkedIds = summarizeKotlinProviderData(unlinkedUser, null).map(
        (entry) => entry.providerId,
      );
      expect(unlinkedIds).toEqual(obs.unlinkedProviderIds);

      expect((await harness.sendOp({ method: 'auth.signOut' })).ok).toBe(true);
      const phoneUid = 'kt-wave4-phone-uid';
      const phoneNumber = '+15550109999';
      const adminCreatePhone = await harness.sendOp({
        method: 'auth.adminCreateUser',
        request: {
          uid: phoneUid,
          phoneNumber,
        },
      });
      expect(adminCreatePhone.ok).toBe(true);
      const phoneToken = mintCustomToken({
        uid: phoneUid,
        projectId,
        nowMs: Date.now(),
      });
      const phoneSession = await harness.sendOp({
        method: 'auth.signInWithCustomToken',
        customToken: phoneToken,
      });
      expect(phoneSession.ok).toBe(true);
      const phoneUser = (phoneSession.value as { user: HostedUserWire }).user;
      expect(phoneUser.phoneNumber).toBe(phoneNumber);
    } finally {
      await harness.close();
    }
  });

  test('auth-kotlin#32 replays linkWithCredential email collision, provider-already-linked, and error-code exception mapping on HostedRuntime and FirebaseAuth.wrapException', async () => {
    const obs = gate.load<AuthKotlinWave4Observation>(OBSERVATION_STEM);
    const ktAuthSource = readFileSync(KT_FIREBASE_AUTH_PATH, 'utf8');

    const harness = await openHostedKotlinBridge({
      projectId: `demo-kt-wave4-collision-${Date.now()}`,
    });
    try {
      const collisionEmail = 'wave4-collision@example.com';
      const password = 'Wave4CollisionPassword!7';

      const seedRes = await harness.sendOp({
        method: 'auth.createUser',
        email: collisionEmail,
        password,
      });
      expect(seedRes.ok).toBe(true);
      const seedUid = (seedRes.value as { user: HostedUserWire }).user.uid;

      const alreadyLinkedRes = await harness.sendOp({
        method: 'auth.linkWithCredential',
        uid: seedUid,
        tenantId: null,
        credential: {
          providerId: 'password',
          signInMethod: 'password',
          email: 'second-password@example.com',
          password,
        },
      });
      expect(alreadyLinkedRes.ok === false).toBe(obs.alreadyLinkedProvider.threw);
      expect(obs.alreadyLinkedProvider.isCollisionSubclass).toBe(false);
      expect(obs.alreadyLinkedProvider.alreadyLinkedProviderMessage).toBe(true);
      expect(ktAuthSource).toContain('combined.contains("provider-already-linked", ignoreCase = true)');
      expect(ktAuthSource).toContain(
        `${obs.alreadyLinkedProvider.exceptionClass}("User has already been linked to the given provider.", e)`,
      );

      expect((await harness.sendOp({ method: 'auth.signOut' })).ok).toBe(true);

      const anonRes = await harness.sendOp({ method: 'auth.signInAnonymously' });
      expect(anonRes.ok).toBe(true);
      const anonUid = (anonRes.value as { user: HostedUserWire }).user.uid;

      const collisionRes = await harness.sendOp({
        method: 'auth.linkWithCredential',
        uid: anonUid,
        tenantId: null,
        credential: {
          providerId: 'password',
          signInMethod: 'password',
          email: collisionEmail,
          password,
        },
      });
      expect(collisionRes.ok === false).toBe(obs.linkCollision.threw);
      let collisionWireCode = '';
      if (collisionRes.error !== undefined) {
        collisionWireCode = collisionRes.error.code;
      }
      expect(collisionWireCode).toBe('auth/email-already-in-use');
      expect(obs.linkCollision.isCollisionSubclass).toBe(true);
      expect(ktAuthSource).toContain(
        `combined.contains("email-already-in-use", ignoreCase = true) -> "${obs.linkCollision.errorCode}"`,
      );
      expect(ktAuthSource).toContain(`${obs.linkCollision.exceptionClass}(code, msg, e)`);

      expect(obs.appleSyntheticSignInOutcome.threw).toBe(true);
      expect(ktAuthSource).toContain(
        `combined.contains("operation-not-allowed", ignoreCase = true) -> "${obs.appleSyntheticSignInOutcome.errorCode}"`,
      );
      expect(ktAuthSource).toContain(
        `else -> ${obs.appleSyntheticSignInOutcome.exceptionClass}(code, msg, e)`,
      );
    } finally {
      await harness.close();
    }
  });

  test('auth-kotlin#37 auth-kotlin#38 auth-kotlin#39 replay GoogleAuthProvider, OAuthProvider, and FirebaseAuth.signInWithCredential parity over HostedRuntime', async () => {
    const obs = gate.load<AuthKotlinWave4Observation>(OBSERVATION_STEM);
    const ktCredentialBase = readFileSync(KT_AUTH_CREDENTIAL_PATH, 'utf8');
    const ktGoogleProvider = readFileSync(KT_GOOGLE_AUTH_PROVIDER_PATH, 'utf8');
    const ktGoogleCredential = readFileSync(KT_GOOGLE_AUTH_CREDENTIAL_PATH, 'utf8');
    const ktOAuthProvider = readFileSync(KT_OAUTH_PROVIDER_PATH, 'utf8');
    const ktOAuthCredential = readFileSync(KT_OAUTH_CREDENTIAL_PATH, 'utf8');
    const ktEmailProvider = readFileSync(KT_EMAIL_AUTH_PROVIDER_PATH, 'utf8');
    const ktAuthSource = readFileSync(KT_FIREBASE_AUTH_PATH, 'utf8');

    expect(ktCredentialBase).toContain('abstract val signInMethod: String');
    expect(ktGoogleProvider).toContain(`const val PROVIDER_ID = "${obs.googleCredentialProvider}"`);
    expect(ktGoogleProvider).toContain(
      `const val GOOGLE_SIGN_IN_METHOD = "${obs.googleCredentialSignInMethod}"`,
    );
    expect(ktGoogleProvider).toContain('return GoogleAuthCredential(');
    expect(ktGoogleCredential).toContain(': AuthCredential(GoogleAuthProvider.PROVIDER_ID)');
    expect(ktGoogleCredential).toContain('Must specify an idToken or an accessToken.');
    expect(ktGoogleCredential).toContain('"signInMethod" to signInMethod');

    expect(obs.githubOAuthProvider).toBe('github.com');
    expect(obs.githubOAuthSignInMethod).toBe('github.com');
    expect(obs.githubOAuthHasIdAndAccessTokens).toBe(true);
    expect(obs.appleOAuthProvider).toBe('apple.com');
    expect(obs.appleOAuthHasIdAndAccessTokens).toBe(true);
    expect(ktOAuthCredential).toContain('override val signInMethod: String = provider');
    expect(ktOAuthCredential).toContain('open val secret: String? = null');
    expect(ktOAuthProvider).toContain('val idToken: String?');
    expect(ktOAuthProvider).toContain('val accessToken: String?');
    expect(ktOAuthProvider).toContain('fun setIdTokenWithRawNonce(idToken: String, rawNonce: String?)');
    expect(ktEmailProvider).toContain('const val PROVIDER_ID = "password"');
    expect(ktEmailProvider).toContain('const val EMAIL_PASSWORD_SIGN_IN_METHOD = "password"');

    const harness = await openHostedKotlinBridge({
      projectId: `demo-kt-wave4-oauth-${Date.now()}`,
    });
    try {
      // 1. Un-staged non-JWT synthetic Google credential rejects and maps to ERROR_INVALID_CREDENTIAL
      const syntheticGoogleRes = await harness.sendOp({
        method: 'auth.signInWithCredential',
        credential: {
          providerId: obs.googleCredentialProvider,
          signInMethod: obs.googleCredentialSignInMethod,
          idToken: 'synthetic-non-jwt-google-id-token',
          accessToken: 'synthetic-google-access-token',
        },
      });
      expect(syntheticGoogleRes.ok === false).toBe(obs.googleSyntheticSignInOutcome.threw);
      expect(obs.googleSyntheticSignInOutcome.isCollisionSubclass).toBe(false);
      expect(ktAuthSource).toContain(
        `combined.contains("no-mock-configured", ignoreCase = true) -> "${obs.googleSyntheticSignInOutcome.errorCode}"`,
      );
      expect(ktAuthSource).toContain(
        `combined.contains("invalid-credential", ignoreCase = true) -> "${obs.googleSyntheticSignInOutcome.errorCode}"`,
      );
      expect(ktAuthSource).toContain(
        `${obs.googleSyntheticSignInOutcome.exceptionClass}(code, msg, e)`,
      );

      // 2. 3-segment Google OIDC ID token authenticates directly via host OIDC JWT fallback
      const googleEmail = 'google-oidc-wave4@example.com';
      const googleOidcJwt = buildUnsignedOidcJwt({
        sub: 'google-oidc-sub-wave4',
        email: googleEmail,
        email_verified: true,
        name: 'Ada Google Wave4',
      });
      const googleSignInRes = await harness.sendOp({
        method: 'auth.signInWithCredential',
        credential: {
          providerId: obs.googleCredentialProvider,
          signInMethod: obs.googleCredentialSignInMethod,
          idToken: googleOidcJwt,
          accessToken: null,
        },
      });
      expect(googleSignInRes.ok).toBe(true);
      const googleUser = (googleSignInRes.value as { user: HostedUserWire }).user;
      expect(googleUser.email).toBe(googleEmail);
      expect(googleUser.isAnonymous).toBe(false);
      expect(summarizeKotlinProviderData(googleUser, googleEmail).map((e) => e.providerId)).toEqual(
        ['firebase', obs.googleCredentialProvider],
      );

      expect((await harness.sendOp({ method: 'auth.signOut' })).ok).toBe(true);

      // 3. Staged generic OAuth (github.com & apple.com) signInWithCredential round-trip
      const githubEmail = 'github-oauth-wave4@example.com';
      const mockGithubRes = await harness.sendOp({
        method: 'auth.mockSignInResult',
        identity: {
          uid: 'github-wave4-uid',
          providerId: obs.githubOAuthProvider,
          email: githubEmail,
          displayName: 'Grace GitHub Wave4',
          photoURL: null,
          customClaims: {},
        },
      });
      expect(mockGithubRes.ok).toBe(true);

      const githubSignInRes = await harness.sendOp({
        method: 'auth.signInWithCredential',
        credential: {
          providerId: obs.githubOAuthProvider,
          signInMethod: obs.githubOAuthSignInMethod,
          idToken: 'staged-github-id-token',
          accessToken: 'gho_staged_access_token',
          rawNonce: null,
        },
      });
      expect(githubSignInRes.ok).toBe(true);
      const githubUser = (githubSignInRes.value as { user: HostedUserWire }).user;
      expect(githubUser.uid).toBe('github-wave4-uid');
      expect(summarizeKotlinProviderData(githubUser, githubEmail).map((e) => e.providerId)).toEqual(
        ['firebase', obs.githubOAuthProvider],
      );

      expect((await harness.sendOp({ method: 'auth.signOut' })).ok).toBe(true);

      const appleEmail = 'apple-oauth-wave4@example.com';
      const mockAppleRes = await harness.sendOp({
        method: 'auth.mockSignInResult',
        identity: {
          uid: 'apple-wave4-uid',
          providerId: obs.appleOAuthProvider,
          email: appleEmail,
          displayName: 'Margaret Apple Wave4',
          photoURL: null,
          customClaims: {},
        },
      });
      expect(mockAppleRes.ok).toBe(true);

      const appleSignInRes = await harness.sendOp({
        method: 'auth.signInWithCredential',
        credential: {
          providerId: obs.appleOAuthProvider,
          signInMethod: obs.appleOAuthProvider,
          idToken: 'staged-apple-id-token',
          accessToken: 'apple_staged_access_token',
          rawNonce: 'wave4-raw-nonce',
        },
      });
      expect(appleSignInRes.ok).toBe(true);
      const appleUser = (appleSignInRes.value as { user: HostedUserWire }).user;
      expect(appleUser.uid).toBe('apple-wave4-uid');
      expect(summarizeKotlinProviderData(appleUser, appleEmail).map((e) => e.providerId)).toEqual([
        'firebase',
        obs.appleOAuthProvider,
      ]);
    } finally {
      await harness.close();
    }
  });

  test('covers Wave 4 auth-kotlin observation through createObservationGate', () => {
    const report = gate.report();
    expect(report.committed).toEqual([OBSERVATION_STEM]);
    expect(report.loadedButUnused).toEqual([]);
    expect(report.uncovered).toEqual([]);
  });
});
