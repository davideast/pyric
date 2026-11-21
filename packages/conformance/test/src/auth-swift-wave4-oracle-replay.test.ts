import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mintCustomToken } from 'pyric/sandbox/internal';
import { createObservationGate } from '../../src/observation-gate.ts';
import { buildUnsignedOidcJwt } from './auth-kotlin-wave4-replay-support.ts';
import {
  AUTH_SWIFT_OBSERVATIONS_DIR,
  normalizeSwiftTopLevelProviderID,
  summarizeSwiftProviderData,
  SWIFT_ADDITIONAL_USER_INFO_PATH,
  SWIFT_AUTH_CREDENTIAL_PATH,
  SWIFT_AUTH_ERROR_CODE_PATH,
  SWIFT_AUTH_ERROR_PATH,
  SWIFT_AUTH_ORACLE_PARITY_PATH,
  SWIFT_AUTH_PATH,
  SWIFT_AUTH_STATE_SEQ_PATH,
  SWIFT_EMAIL_AUTH_PROVIDER_PATH,
  SWIFT_GOOGLE_AUTH_PROVIDER_PATH,
  SWIFT_ID_TOKEN_SEQ_PATH,
  SWIFT_LIVE_HOST_AUTH_TEST_PATH,
  SWIFT_OAUTH_CREDENTIAL_PATH,
  SWIFT_OAUTH_PROVIDER_PATH,
  SWIFT_USER_INFO_IMPL_PATH,
  SWIFT_USER_METADATA_PATH,
  SWIFT_USER_PATH,
  WAVE4_AUTH_SWIFT_STEM,
  type AuthSwiftWave4Observation,
  type HostedSwiftUserWire,
} from './auth-swift-oracle-replay-support.ts';
import { openHostedKotlinBridge } from './kotlin-hosted-bridge-harness.ts';

const gate = createObservationGate({
  dir: AUTH_SWIFT_OBSERVATIONS_DIR,
  match: (filename) => filename === `${WAVE4_AUTH_SWIFT_STEM}.json`,
});

describe('Wave 4 auth-swift iOS SDK 13.2.0 production observation replay over hosted worker bridge', () => {
  test('auth-swift#1 auth-swift#2 auth-swift#4 auth-swift#34 replay default/named Auth.auth(), app binding, tenantID isolation, and languageCode / useAppLanguage', async () => {
    const obs = gate.load<AuthSwiftWave4Observation>(WAVE4_AUTH_SWIFT_STEM);
    const swiftAuthSource = readFileSync(SWIFT_AUTH_PATH, 'utf8');
    const swiftParitySource = readFileSync(SWIFT_AUTH_ORACLE_PARITY_PATH, 'utf8');
    const swiftUserSource = readFileSync(SWIFT_USER_PATH, 'utf8');

    expect(obs.defaultAuthSingletonIdentical).toBe(true);
    expect(obs.defaultAuthAppIsDefault).toBe(true);
    expect(obs.namedAuthSingletonIdentical).toBe(true);
    expect(obs.namedAuthAppMatchesConfigured).toBe(true);
    expect(obs.initialTenantIdNil).toBe(true);
    expect(obs.mainAppTenantIdNil).toBe(true);
    expect(obs.explicitLanguageCode).toBe('de');
    expect(obs.afterUseAppLanguageValid).toBe(true);

    expect(swiftAuthSource).toContain('public static func auth() -> Auth');
    expect(swiftAuthSource).toContain('return auth(app: FirebaseApp.app())');
    expect(swiftAuthSource).toContain('public static func auth(app: FirebaseApp) -> Auth');
    expect(swiftAuthSource).toContain('public let app: FirebaseApp');
    expect(swiftParitySource).toContain('public var tenantID: String?');
    expect(swiftParitySource).toContain('public var languageCode: String?');
    expect(swiftParitySource).toContain('public func useAppLanguage()');
    expect(swiftUserSource).toContain('public var tenant: String?');
    expect(swiftUserSource).toContain('public var tenantID: String?');

    const projectId = `demo-swift-wave4-tenant-${Date.now()}`;
    const harness = await openHostedKotlinBridge({ projectId });
    try {
      const defaultAnon = await harness.sendOp({ method: 'auth.signInAnonymously' });
      expect(defaultAnon.ok).toBe(true);
      const defaultUser = (defaultAnon.value as { user: HostedSwiftUserWire }).user;
      expect(defaultUser.tenantId === null).toBe(obs.initialTenantIdNil);
      expect(defaultUser.tenantId === null).toBe(obs.anonymousUserTenantIdNil);

      expect((await harness.sendOp({ method: 'auth.signOut' })).ok).toBe(true);

      const tenantEmail = 'swift-wave4-tenant@example.com';
      const tenantPassword = 'SwiftWave4TenantPassword!9';
      const tenantCreate = await harness.sendOp({
        method: 'auth.createUser',
        email: tenantEmail,
        password: tenantPassword,
        tenantId: obs.configuredTenantId,
      });
      expect(tenantCreate.ok).toBe(true);
      const tenantUser = (tenantCreate.value as { user: HostedSwiftUserWire }).user;
      expect(tenantUser.tenantId).toBe(obs.configuredTenantId);

      expect((await harness.sendOp({ method: 'auth.signOut' })).ok).toBe(true);
      const crossTenantSignIn = await harness.sendOp({
        method: 'auth.signInEmail',
        email: tenantEmail,
        password: tenantPassword,
      });
      expect(crossTenantSignIn.ok).toBe(false);

      const mainAnon = await harness.sendOp({ method: 'auth.signInAnonymously' });
      expect(mainAnon.ok).toBe(true);
      const mainUser = (mainAnon.value as { user: HostedSwiftUserWire }).user;
      expect(mainUser.tenantId === null).toBe(obs.mainAppTenantIdNil);
    } finally {
      await harness.close();
    }
  });

  test('auth-swift#15 auth-swift#16 auth-swift#17 auth-swift#18 auth-swift#21 auth-swift#22 auth-swift#36 replay state/ID-token listeners, AsyncSequences, and getIDToken(forcingRefresh:)', async () => {
    const obs = gate.load<AuthSwiftWave4Observation>(WAVE4_AUTH_SWIFT_STEM);
    const swiftAuthSource = readFileSync(SWIFT_AUTH_PATH, 'utf8');
    const swiftStateSeqSource = readFileSync(SWIFT_AUTH_STATE_SEQ_PATH, 'utf8');
    const swiftTokenSeqSource = readFileSync(SWIFT_ID_TOKEN_SEQ_PATH, 'utf8');
    const swiftUserSource = readFileSync(SWIFT_USER_PATH, 'utf8');

    expect(obs.asyncSequenceInitialStateNil).toBe(true);
    expect(obs.asyncSequenceInitialIdTokenNil).toBe(true);
    expect(swiftAuthSource).toContain('public func addStateDidChangeListener(');
    expect(swiftAuthSource).toContain('public func removeStateDidChangeListener(');
    expect(swiftAuthSource).toContain('public func addIDTokenDidChangeListener(');
    expect(swiftAuthSource).toContain('public func removeIDTokenDidChangeListener(');
    expect(swiftAuthSource).toContain('public var authStateChanges: AuthStateChangesSequence');
    expect(swiftAuthSource).toContain('public var idTokenChanges: IDTokenChangesSequence');
    expect(swiftStateSeqSource).toContain('public struct AuthStateChangesSequence: AsyncSequence');
    expect(swiftTokenSeqSource).toContain('public struct IDTokenChangesSequence: AsyncSequence');
    expect(swiftUserSource).toContain(
      'public func getIDToken(forcingRefresh: Bool = false) async throws -> String',
    );

    const harness = await openHostedKotlinBridge({
      projectId: `demo-swift-wave4-listeners-${Date.now()}`,
    });
    try {
      const stateEvents: Array<string | null> = [];
      const tokenEvents: Array<string | null> = [];

      harness.subscribe('sub-swift-state', { target: 'authState' }, (val) => {
        const wire = val as HostedSwiftUserWire | null;
        if (wire === null) {
          stateEvents.push(null);
        } else {
          stateEvents.push(wire.uid);
        }
      });
      harness.subscribe('sub-swift-token', { target: 'idToken' }, (val) => {
        const wire = val as HostedSwiftUserWire | null;
        if (wire === null) {
          tokenEvents.push(null);
        } else {
          tokenEvents.push(wire.uid);
        }
      });

      await new Promise<void>((resolveTick) => setTimeout(resolveTick, 30));
      expect(stateEvents[0] === null && tokenEvents[0] === null).toBe(obs.stateListenerInitialNil);

      const anonRes = await harness.sendOp({ method: 'auth.signInAnonymously' });
      expect(anonRes.ok).toBe(true);

      const cachedTokenRes = await harness.sendOp({
        method: 'auth.getIdToken',
        forceRefresh: false,
      });
      expect(cachedTokenRes.ok).toBe(true);
      const cachedJwt = cachedTokenRes.value as string;

      const forcedTokenRes = await harness.sendOp({
        method: 'auth.getIdToken',
        forceRefresh: true,
      });
      expect(forcedTokenRes.ok).toBe(true);
      const refreshedJwt = forcedTokenRes.value as string;
      expect(cachedJwt.split('.').length === 3 && refreshedJwt.split('.').length === 3).toBe(
        obs.getIDTokenSegmentCountsValid,
      );

      await new Promise<void>((resolveTick) => setTimeout(resolveTick, 30));
      expect(stateEvents.some((uid) => uid !== null)).toBe(obs.stateListenerObservedTransitions);
      expect(tokenEvents.length >= stateEvents.length).toBe(
        obs.idTokenListenerMoreGranularOrEqual,
      );

      harness.unsubscribe('sub-swift-state');
      harness.unsubscribe('sub-swift-token');
      const stateLenBeforeRemove = stateEvents.length;
      const tokenLenBeforeRemove = tokenEvents.length;

      expect((await harness.sendOp({ method: 'auth.signOut' })).ok).toBe(true);
      await new Promise<void>((resolveTick) => setTimeout(resolveTick, 30));
      expect(
        stateEvents.length === stateLenBeforeRemove && tokenEvents.length === tokenLenBeforeRemove,
      ).toBe(obs.silentAfterRemoveListeners);
    } finally {
      await harness.close();
    }
  });

  test('auth-swift#29 auth-swift#32 auth-swift#33 auth-swift#43 auth-swift#47 replay User.providerID Firebase, phoneNumber, metadata, AdditionalUserInfo.isNewUser, providerData UserInfoImpl, link, reauthenticate, updatePassword, and unlink', async () => {
    const obs = gate.load<AuthSwiftWave4Observation>(WAVE4_AUTH_SWIFT_STEM);
    const swiftUserSource = readFileSync(SWIFT_USER_PATH, 'utf8');
    const swiftParitySource = readFileSync(SWIFT_AUTH_ORACLE_PARITY_PATH, 'utf8');
    const swiftMetadataSource = readFileSync(SWIFT_USER_METADATA_PATH, 'utf8');
    const swiftAddInfoSource = readFileSync(SWIFT_ADDITIONAL_USER_INFO_PATH, 'utf8');
    const swiftUserInfoSource = readFileSync(SWIFT_USER_INFO_IMPL_PATH, 'utf8');
    const swiftLiveHostSource = readFileSync(SWIFT_LIVE_HOST_AUTH_TEST_PATH, 'utf8');

    expect(swiftUserSource).toContain(
      `public static let firebaseProviderID = "${obs.anonymousTopLevelProviderID}"`,
    );
    expect(swiftUserSource).toContain('decodeUserCredentialWire(reply, existingUser: self)');
    expect(swiftParitySource).toContain('existingUser.update(from: userDict)');
    expect(swiftLiveHostSource).toContain(
      `#expect(richUser.providerID == "${obs.anonymousTopLevelProviderID}")`,
    );
    expect(obs.anonymousMetadataHasDates).toBe(true);
    expect(swiftMetadataSource).toContain('public let creationDate: Date?');
    expect(swiftMetadataSource).toContain('public let lastSignInDate: Date?');
    expect(swiftAddInfoSource).toContain('public let isNewUser: Bool');
    expect(swiftUserInfoSource).toContain('public struct UserInfoImpl: UserInfo');

    const projectId = `demo-swift-wave4-link-${Date.now()}`;
    const harness = await openHostedKotlinBridge({ projectId });
    try {
      const anonRes = await harness.sendOp({ method: 'auth.signInAnonymously' });
      expect(anonRes.ok).toBe(true);
      const anonPayload = anonRes.value as {
        user: HostedSwiftUserWire;
        additionalUserInfo?: { isNewUser?: boolean };
      };
      const anonUser = anonPayload.user;
      expect(anonPayload.additionalUserInfo?.isNewUser).toBe(obs.anonymousIsNewUser);
      expect(normalizeSwiftTopLevelProviderID(anonUser.providerId)).toBe(
        obs.anonymousTopLevelProviderID,
      );
      expect(anonUser.phoneNumber === null).toBe(obs.anonymousPhoneNumberNil);
      expect(summarizeSwiftProviderData(anonUser, null)).toEqual(obs.anonymousProviderEntries);

      const upgradeEmail = 'swift-wave4-upgrade@example.com';
      const initialPassword = 'SwiftWave4InitialPassword!8';
      const updatedPassword = 'SwiftWave4UpdatedPassword!9';

      const linkRes = await harness.sendOp({
        method: 'auth.linkWithCredential',
        uid: anonUser.uid,
        tenantId: null,
        credential: {
          providerId: obs.emailProviderConstant,
          signInMethod: obs.emailProviderConstant,
          email: upgradeEmail,
          password: initialPassword,
        },
      });
      expect(linkRes.ok).toBe(true);
      const linkedUser = (linkRes.value as { user: HostedSwiftUserWire }).user;
      expect(linkedUser.uid === anonUser.uid).toBe(obs.linkPreservedUid);
      expect(linkedUser.isAnonymous).toBe(obs.linkedIsAnonymous);
      expect(linkedUser.email === upgradeEmail).toBe(obs.linkedEmailMatches);
      expect(linkedUser.phoneNumber === null).toBe(obs.linkedPhoneNumberNil);
      expect(summarizeSwiftProviderData(linkedUser, upgradeEmail)).toEqual(
        obs.linkedProviderEntries,
      );

      expect((await harness.sendOp({ method: 'auth.signOut' })).ok).toBe(true);
      const reloginRes = await harness.sendOp({
        method: 'auth.signInEmail',
        email: upgradeEmail,
        password: initialPassword,
      });
      expect(reloginRes.ok).toBe(true);
      const reloginPayload = reloginRes.value as {
        user: HostedSwiftUserWire;
        additionalUserInfo?: { isNewUser?: boolean };
      };
      expect(reloginPayload.additionalUserInfo?.isNewUser).toBe(obs.existingSignInIsNewUser);

      const reauthRes = await harness.sendOp({
        method: 'auth.reauthenticateWithCredential',
        uid: anonUser.uid,
        tenantId: null,
        credential: {
          providerId: obs.emailProviderConstant,
          signInMethod: obs.emailProviderConstant,
          email: upgradeEmail,
          password: initialPassword,
        },
      });
      expect(reauthRes.ok).toBe(true);
      const reauthUser = (reauthRes.value as { user: HostedSwiftUserWire }).user;
      expect(reauthUser.uid === anonUser.uid).toBe(obs.reauthenticatePreservedUid);

      expect(
        (await harness.sendOp({ method: 'auth.updatePassword', password: updatedPassword })).ok,
      ).toBe(true);
      expect((await harness.sendOp({ method: 'auth.signOut' })).ok).toBe(true);

      const signInUpdatedRes = await harness.sendOp({
        method: 'auth.signInWithCredential',
        credential: {
          providerId: obs.emailProviderConstant,
          signInMethod: obs.emailProviderConstant,
          email: upgradeEmail,
          password: updatedPassword,
        },
      });
      expect(signInUpdatedRes.ok).toBe(true);
      const updatedUser = (signInUpdatedRes.value as { user: HostedSwiftUserWire }).user;
      expect(updatedUser.uid === anonUser.uid).toBe(obs.updatedPasswordCredentialSameUid);

      const unlinkRes = await harness.sendOp({
        method: 'auth.unlink',
        uid: anonUser.uid,
        tenantId: null,
        providerId: obs.emailProviderConstant,
      });
      expect(unlinkRes.ok).toBe(true);
      const unlinkedUser = unlinkRes.value as HostedSwiftUserWire;
      const unlinkedIDs = summarizeSwiftProviderData(unlinkedUser, null).map((e) => e.providerID);
      expect(unlinkedIDs).toEqual(obs.unlinkedProviderIDs);

      expect((await harness.sendOp({ method: 'auth.signOut' })).ok).toBe(true);
      const phoneUid = 'swift-wave4-phone-uid';
      const phoneNumber = '+15550108888';
      expect(
        (
          await harness.sendOp({
            method: 'auth.adminCreateUser',
            request: { uid: phoneUid, phoneNumber },
          })
        ).ok,
      ).toBe(true);
      const phoneJwt = mintCustomToken({ uid: phoneUid, projectId, nowMs: Date.now() });
      const phoneSignIn = await harness.sendOp({
        method: 'auth.signInWithCustomToken',
        customToken: phoneJwt,
      });
      expect(phoneSignIn.ok).toBe(true);
      expect((phoneSignIn.value as { user: HostedSwiftUserWire }).user.phoneNumber).toBe(
        phoneNumber,
      );
    } finally {
      await harness.close();
    }
  });

  test('auth-swift#53 auth-swift#54 auth-swift#55 auth-swift#56 auth-swift#57 replay link collisions, provider-already-linked, GoogleAuthProvider, OAuthProvider, and Auth.signIn(with:)', async () => {
    const obs = gate.load<AuthSwiftWave4Observation>(WAVE4_AUTH_SWIFT_STEM);
    const swiftCredBase = readFileSync(SWIFT_AUTH_CREDENTIAL_PATH, 'utf8');
    const swiftEmailProvider = readFileSync(SWIFT_EMAIL_AUTH_PROVIDER_PATH, 'utf8');
    const swiftGoogleProvider = readFileSync(SWIFT_GOOGLE_AUTH_PROVIDER_PATH, 'utf8');
    const swiftOAuthProvider = readFileSync(SWIFT_OAUTH_PROVIDER_PATH, 'utf8');
    const swiftOAuthCredential = readFileSync(SWIFT_OAUTH_CREDENTIAL_PATH, 'utf8');
    const swiftErrorCode = readFileSync(SWIFT_AUTH_ERROR_CODE_PATH, 'utf8');
    const swiftError = readFileSync(SWIFT_AUTH_ERROR_PATH, 'utf8');

    expect(swiftCredBase).toContain('"signInMethod": .string(provider)');
    expect(swiftEmailProvider).toContain(`public static let id = "${obs.emailProviderConstant}"`);
    expect(swiftGoogleProvider).toContain(
      `public static let providerID = "${obs.googleCredentialProvider}"`,
    );
    expect(obs.githubOAuthHasIdAndAccessTokens).toBe(true);
    expect(obs.appleOAuthHasIdAndAccessTokens).toBe(true);
    expect(swiftOAuthProvider).toContain(`case .gitHub: return "${obs.githubOAuthProvider}"`);
    expect(swiftOAuthProvider).toContain(`case .apple: return "${obs.appleOAuthProvider}"`);
    expect(swiftOAuthProvider).toContain('case .custom(let id): return id');
    expect(obs.customOidcProvider).toBe('oidc.demo-idp');
    expect(swiftOAuthCredential).toContain('public let idToken: String?');
    expect(swiftOAuthCredential).toContain('public let accessToken: String?');
    expect(swiftOAuthCredential).toContain('public let rawNonce: String?');

    const harness = await openHostedKotlinBridge({
      projectId: `demo-swift-wave4-oauth-${Date.now()}`,
    });
    try {
      const collisionEmail = 'swift-wave4-collision@example.com';
      const password = 'SwiftWave4CollisionPassword!7';

      const seedRes = await harness.sendOp({
        method: 'auth.createUser',
        email: collisionEmail,
        password,
      });
      expect(seedRes.ok).toBe(true);
      const seedUid = (seedRes.value as { user: HostedSwiftUserWire }).user.uid;

      const alreadyLinkedRes = await harness.sendOp({
        method: 'auth.linkWithCredential',
        uid: seedUid,
        tenantId: null,
        credential: {
          providerId: obs.emailProviderConstant,
          signInMethod: obs.emailProviderConstant,
          email: 'second-swift-password@example.com',
          password,
        },
      });
      expect(!alreadyLinkedRes.ok).toBe(obs.alreadyLinkedProvider.threw);
      expect(alreadyLinkedRes.error?.code).toBe('auth/provider-already-linked');
      expect(obs.alreadyLinkedProvider.matchesProviderAlreadyLinkedEnum).toBe(true);
      expect(swiftError).toContain(`public let AuthErrorDomain = "${obs.alreadyLinkedProvider.domain}"`);
      expect(swiftErrorCode).toContain(
        `case .providerAlreadyLinked: return ${obs.alreadyLinkedProvider.code}`,
      );
      expect(swiftErrorCode).toContain(
        `case .providerAlreadyLinked: return "${obs.alreadyLinkedProvider.errorName}"`,
      );

      expect((await harness.sendOp({ method: 'auth.signOut' })).ok).toBe(true);
      const anonRes = await harness.sendOp({ method: 'auth.signInAnonymously' });
      expect(anonRes.ok).toBe(true);
      const anonUid = (anonRes.value as { user: HostedSwiftUserWire }).user.uid;

      const collisionRes = await harness.sendOp({
        method: 'auth.linkWithCredential',
        uid: anonUid,
        tenantId: null,
        credential: {
          providerId: obs.emailProviderConstant,
          signInMethod: obs.emailProviderConstant,
          email: collisionEmail,
          password,
        },
      });
      expect(!collisionRes.ok).toBe(obs.linkCollision.threw);
      expect(collisionRes.error?.code).toBe('auth/email-already-in-use');
      expect(obs.linkCollision.matchesCollisionEnum).toBe(true);
      expect(swiftErrorCode).toContain(`case .emailAlreadyInUse: return ${obs.linkCollision.code}`);
      expect(swiftErrorCode).toContain(
        `case .emailAlreadyInUse: return "${obs.linkCollision.errorName}"`,
      );

      const syntheticGoogleRes = await harness.sendOp({
        method: 'auth.signInWithCredential',
        credential: {
          providerId: obs.googleCredentialProvider,
          signInMethod: obs.googleCredentialProvider,
          idToken: 'synthetic-google-id-token',
          accessToken: 'synthetic-google-access-token',
        },
      });
      expect(!syntheticGoogleRes.ok).toBe(obs.googleSyntheticSignInOutcome.threw);
      expect(swiftErrorCode).toContain(
        `case .invalidCredential, .noMockConfigured: return ${obs.googleSyntheticSignInOutcome.code}`,
      );
      expect(swiftErrorCode).toContain(
        `case .invalidCredential, .noMockConfigured: return "${obs.googleSyntheticSignInOutcome.errorName}"`,
      );

      expect(obs.appleSyntheticSignInOutcome.threw).toBe(true);
      expect(swiftErrorCode).toContain(
        `case .operationNotAllowed: return ${obs.appleSyntheticSignInOutcome.code}`,
      );
      expect(swiftErrorCode).toContain(
        `case .operationNotAllowed: return "${obs.appleSyntheticSignInOutcome.errorName}"`,
      );

      const googleEmail = 'swift-google-oidc@example.com';
      const googleOidcJwt = buildUnsignedOidcJwt({
        sub: 'swift-google-sub-wave4',
        email: googleEmail,
        email_verified: true,
        name: 'Ada Swift Google',
      });
      const googleSignInRes = await harness.sendOp({
        method: 'auth.signInWithCredential',
        credential: {
          providerId: obs.googleCredentialProvider,
          signInMethod: obs.googleCredentialProvider,
          idToken: googleOidcJwt,
        },
      });
      expect(googleSignInRes.ok).toBe(true);
      const googleUser = (googleSignInRes.value as { user: HostedSwiftUserWire }).user;
      expect(summarizeSwiftProviderData(googleUser, googleEmail).map((e) => e.providerID)).toEqual([
        obs.googleCredentialProvider,
      ]);

      expect((await harness.sendOp({ method: 'auth.signOut' })).ok).toBe(true);
      const githubEmail = 'swift-github-wave4@example.com';
      expect(
        (
          await harness.sendOp({
            method: 'auth.mockSignInResult',
            identity: {
              uid: 'swift-github-uid',
              providerId: obs.githubOAuthProvider,
              email: githubEmail,
              displayName: 'Grace Swift GitHub',
              photoURL: null,
              customClaims: {},
            },
          })
        ).ok,
      ).toBe(true);
      const githubSignInRes = await harness.sendOp({
        method: 'auth.signInWithCredential',
        credential: {
          providerId: obs.githubOAuthProvider,
          signInMethod: obs.githubOAuthProvider,
          idToken: 'staged-gh-id',
          accessToken: 'staged-gh-access',
        },
      });
      expect(githubSignInRes.ok).toBe(true);
      const githubUser = (githubSignInRes.value as { user: HostedSwiftUserWire }).user;
      expect(summarizeSwiftProviderData(githubUser, githubEmail).map((e) => e.providerID)).toEqual([
        obs.githubOAuthProvider,
      ]);
    } finally {
      await harness.close();
    }
  });

  test('covers Wave 4 auth-swift observation through createObservationGate', () => {
    const report = gate.report();
    expect(report.committed).toEqual([WAVE4_AUTH_SWIFT_STEM]);
    expect(report.loadedButUnused).toEqual([]);
    expect(report.uncovered).toEqual([]);
  });
});
