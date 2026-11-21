import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintCustomToken } from 'pyric/sandbox/internal';
import { REPO_ROOT } from '../../src/ledger.ts';
import { createObservationGate } from '../../src/observation-gate.ts';
import { openHostedKotlinBridge } from './kotlin-hosted-bridge-harness.ts';

interface ProviderEntrySummary {
  providerId: string;
  uidNonBlank: boolean;
  uidEqualsUserUid: boolean;
  emailMatchesExpected: boolean;
  emailIsNull: boolean;
  phoneNumberIsNull: boolean;
}

interface Wave4AuthFailureOutcome {
  threw: boolean;
  exceptionClass: string;
  isCollisionSubclass: boolean;
  errorCode?: string;
  alreadyLinkedProviderMessage?: boolean;
}

interface AuthKotlinWave4Observation {
  defaultAuthSameAsFirebaseKtx: boolean;
  defaultAuthAppIsDefault: boolean;
  namedAuthSameAsFirebaseKtx: boolean;
  authAppMatchesInitializedApp: boolean;
  initialTenantIdNull: boolean;
  configuredTenantId: string;
  separateAppTenantIdNull: boolean;
  explicitLanguageCode: string;
  afterUseAppLanguageValid: boolean;
  anonymousPhoneNumberNull: boolean;
  anonymousProviderEntries: ProviderEntrySummary[];
  linkPreservedUid: boolean;
  linkedIsAnonymous: boolean;
  linkedEmailMatches: boolean;
  linkedPhoneNumberNull: boolean;
  linkedProviderEntries: ProviderEntrySummary[];
  linkCollision: Wave4AuthFailureOutcome;
  alreadyLinkedProvider: Wave4AuthFailureOutcome;
  reauthenticatePreservedUid: boolean;
  updatedPasswordCredentialSameUid: boolean;
  unlinkedProviderIds: string[];
  googleCredentialProvider: string;
  googleCredentialSignInMethod: string;
  githubOAuthProvider: string;
  githubOAuthSignInMethod: string;
  githubOAuthHasIdAndAccessTokens: boolean;
  appleOAuthProvider: string;
  appleOAuthHasIdAndAccessTokens: boolean;
  googleSyntheticSignInOutcome: Wave4AuthFailureOutcome;
  appleSyntheticSignInOutcome: Wave4AuthFailureOutcome;
}

interface HostedUserWire {
  uid: string;
  email: string | null;
  phoneNumber: string | null;
  isAnonymous: boolean;
  providerId?: string;
  tenantId?: string | null;
  providerData?: Array<{
    uid?: string;
    email?: string | null;
    phoneNumber?: string | null;
    providerId?: string;
  }>;
}

const OBSERVATION_STEM = 'auth-kotlin-instance-linking-reauth-and-oauth-credentials';

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

const KT_AUTH_KTX_PATH = join(
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
  'Auth.kt',
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
  match: (filename) => filename === `${OBSERVATION_STEM}.json`,
});

function summarizeKotlinProviderData(
  user: HostedUserWire,
  expectedEmail: string | null,
): ProviderEntrySummary[] {
  const masterEntry: ProviderEntrySummary = {
    providerId: 'firebase',
    uidNonBlank: user.uid.trim().length > 0,
    uidEqualsUserUid: true,
    emailMatchesExpected: expectedEmail !== null && user.email === expectedEmail,
    emailIsNull: user.email === null,
    phoneNumberIsNull: user.phoneNumber === null,
  };
  const linkedEntries: ProviderEntrySummary[] = [];
  if (Array.isArray(user.providerData)) {
    for (const raw of user.providerData) {
      let providerId = '';
      if (typeof raw.providerId === 'string') {
        providerId = raw.providerId;
      }
      if (providerId === 'firebase') {
        continue;
      }
      let entryUid = '';
      if (typeof raw.uid === 'string') {
        entryUid = raw.uid;
      }
      let entryEmail: string | null = null;
      if (typeof raw.email === 'string') {
        entryEmail = raw.email;
      }
      let entryPhone: string | null = null;
      if (typeof raw.phoneNumber === 'string') {
        entryPhone = raw.phoneNumber;
      }
      linkedEntries.push({
        providerId,
        uidNonBlank: entryUid.trim().length > 0,
        uidEqualsUserUid: entryUid === user.uid,
        emailMatchesExpected: expectedEmail !== null && entryEmail === expectedEmail,
        emailIsNull: entryEmail === null,
        phoneNumberIsNull: entryPhone === null,
      });
    }
  }
  return [masterEntry, ...linkedEntries];
}

describe('Wave 4 auth-kotlin Android SDK production observation replay over hosted worker bridge', () => {
  test('auth-kotlin#1 auth-kotlin#2 auth-kotlin#3 auth-kotlin#4 replay default/named FirebaseAuth, Firebase.auth KTX, app binding, and multi-tenant isolation', async () => {
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

    expect(ktAuthSource).toContain(
      'fun getInstance(): FirebaseAuth = getInstance(FirebaseApp.getInstance())',
    );
    expect(ktAuthSource).toContain('fun getInstance(app: FirebaseApp): FirebaseAuth');
    expect(ktAuthSource).toContain('val app: FirebaseApp,');
    expect(ktAuthSource).toContain('var tenantId: String? = null');
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

  test('auth-kotlin#32 replays linkWithCredential email collision and error-code exception mapping on HostedRuntime and FirebaseAuth.wrapException', async () => {
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

      expect(obs.googleSyntheticSignInOutcome.threw).toBe(true);
      expect(ktAuthSource).toContain(
        `combined.contains("invalid-credential", ignoreCase = true) -> "${obs.googleSyntheticSignInOutcome.errorCode}"`,
      );
      expect(ktAuthSource).toContain(
        `${obs.googleSyntheticSignInOutcome.exceptionClass}(code, msg, e)`,
      );

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

  test('covers Wave 4 auth-kotlin observation through createObservationGate', () => {
    const report = gate.report();
    expect(report.committed).toEqual([OBSERVATION_STEM]);
    expect(report.loadedButUnused).toEqual([]);
    expect(report.uncovered).toEqual([]);
  });
});
