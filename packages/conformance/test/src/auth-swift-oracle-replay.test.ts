import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mintCustomToken } from 'pyric/sandbox/internal';
import { createObservationGate } from '../../src/observation-gate.ts';
import {
  AUTH_SWIFT_OBSERVATIONS_DIR,
  SWIFT_AUTH_DATA_RESULT_PATH,
  SWIFT_AUTH_ERROR_CODE_PATH,
  SWIFT_AUTH_ERROR_PATH,
  SWIFT_AUTH_PATH,
  SWIFT_AUTH_TOKEN_RESULT_PATH,
  SWIFT_LIVE_HOST_PARITY_TEST_PATH,
  SWIFT_PROFILE_REQUEST_PATH,
  SWIFT_USER_PATH,
  WAVE4_AUTH_SWIFT_STEM,
  type HostedSwiftUserWire,
} from './auth-swift-oracle-replay-support.ts';
import { openHostedKotlinBridge } from './kotlin-hosted-bridge-harness.ts';

interface AuthSwiftAnonymousAndCustomTokenObservation {
  anonymousIsAnonymous: boolean;
  anonymousMatchesCurrent: boolean;
  currentUserNilAfterSignOut: boolean;
  customClaimsRole: string;
  customClaimsTier: number;
  customIsAnonymous: boolean;
  customUidMatchesExpected: boolean;
  invalidCustomTokenCode: number;
  invalidCustomTokenDomain: string;
  invalidCustomTokenErrorName: string;
  invalidCustomTokenMatchesEnum: boolean;
  signInProvider: string;
}

interface AuthSwiftEmailPasswordAndErrorCodesObservation {
  currentUserMatchesAfterSignIn: boolean;
  currentUserMatchesAfterSignUp: boolean;
  duplicateEmailCode: number;
  duplicateEmailDomain: string;
  duplicateEmailErrorName: string;
  duplicateEmailMatchesEnum: boolean;
  invalidEmailCode: number;
  invalidEmailDomain: string;
  invalidEmailErrorName: string;
  invalidEmailMatchesEnum: boolean;
  signInIsAnonymous: boolean;
  signInUidMatchesSignUp: boolean;
  signUpEmailMatches: boolean;
  signUpEmailVerified: boolean;
  signUpIsAnonymous: boolean;
  userNotFoundCode: number;
  userNotFoundDomain: string;
  userNotFoundErrorName: string;
  userNotFoundMatchesExpectedEnum: boolean;
  wrongPasswordCode: number;
  wrongPasswordDomain: string;
  wrongPasswordErrorName: string;
  wrongPasswordMatchesExpectedEnum: boolean;
}

interface AuthSwiftProfileTokenClaimsAndDeleteObservation {
  claimEmailMatchesUser: boolean;
  claimEmailVerified: boolean;
  claimNameAfterProfileUpdate: string;
  claimPictureAfterProfileUpdate: string;
  claimSubMatchesUid: boolean;
  claimUserIdMatchesUid: boolean;
  currentUserNilAfterDelete: boolean;
  displayNameAfterCommit: string;
  displayNameAfterReload: string;
  expirationAfterAuthDate: boolean;
  firebaseEmailIdentityCount: number;
  firebaseSignInProvider: string;
  initialDisplayNameNil: boolean;
  initialPhotoUrlNil: boolean;
  issuedAtPresent: boolean;
  jwtSegmentCount: number;
  photoUrlAfterCommit: string;
  photoUrlAfterReload: string;
  signInAfterDeleteCode: number;
  signInAfterDeleteDomain: string;
  signInAfterDeleteErrorName: string;
  signInAfterDeleteMatchesExpectedEnum: boolean;
  signInAfterDeleteRejected: boolean;
  signInProvider: string;
}

const gate = createObservationGate({
  dir: AUTH_SWIFT_OBSERVATIONS_DIR,
  match: (filename) =>
    filename.startsWith('auth-swift-') && filename !== `${WAVE4_AUTH_SWIFT_STEM}.json`,
});

describe('auth-swift iOS SDK 13.2.0 production observation replay over hosted worker bridge', () => {
  test('auth-swift#2 auth-swift#10 auth-swift#12 auth-swift#14 auth-swift#25 auth-swift#30 auth-swift#35 auth-swift#38 auth-swift#42 auth-swift#45 auth-swift#53 auth-swift#54 replay anonymous sign-in, custom-token claims, invalid custom-token FIRAuthErrorDomain 17000, and signOut', async () => {
    const obs = gate.load<AuthSwiftAnonymousAndCustomTokenObservation>(
      'auth-swift-anonymous-and-custom-token-session',
    );
    const swiftAuthSource = readFileSync(SWIFT_AUTH_PATH, 'utf8');
    const swiftUserSource = readFileSync(SWIFT_USER_PATH, 'utf8');
    const swiftAuthDataResultSource = readFileSync(SWIFT_AUTH_DATA_RESULT_PATH, 'utf8');
    const swiftErrorCodeSource = readFileSync(SWIFT_AUTH_ERROR_CODE_PATH, 'utf8');
    const swiftErrorSource = readFileSync(SWIFT_AUTH_ERROR_PATH, 'utf8');

    expect(swiftAuthSource).toContain('public static func auth(app: FirebaseApp) -> Auth');
    expect(swiftAuthSource).toContain('public func signInAnonymously() async throws -> AuthDataResult');
    expect(swiftAuthSource).toContain('public func signIn(withCustomToken customToken: String) async throws -> AuthDataResult');
    expect(swiftAuthSource).toContain('public func signOut() throws');
    expect(swiftAuthSource).toContain('public var currentUser: User?');
    expect(swiftAuthDataResultSource).toContain('public let user: User');
    expect(swiftUserSource).toContain('public var claims: [String: AnySendable]');

    const projectId = `demo-swift-anon-${Date.now()}`;
    const harness = await openHostedKotlinBridge({ projectId });
    try {
      const anonRes = await harness.sendOp({ method: 'auth.signInAnonymously' });
      expect(anonRes.ok).toBe(true);
      const anonUser = (anonRes.value as { user: HostedSwiftUserWire }).user;
      expect(anonUser.isAnonymous).toBe(obs.anonymousIsAnonymous);

      const currentAnon = await harness.sendOp({ method: 'auth.getCurrentUser' });
      expect(currentAnon.ok).toBe(true);
      const currentAnonUser = currentAnon.value as HostedSwiftUserWire | null;
      let currentMatchesAnon = false;
      if (currentAnonUser !== null) {
        currentMatchesAnon = currentAnonUser.uid === anonUser.uid;
      }
      expect(currentMatchesAnon).toBe(obs.anonymousMatchesCurrent);

      const expectedUid = 'ios-replay-custom-uid';
      const customToken = mintCustomToken({
        uid: expectedUid,
        claims: { role: 'tester', tier: 2 },
        projectId,
        nowMs: Date.now(),
      });
      const customRes = await harness.sendOp({
        method: 'auth.signInWithCustomToken',
        customToken,
      });
      expect(customRes.ok).toBe(true);
      const customUser = (customRes.value as { user: HostedSwiftUserWire }).user;
      expect(customUser.uid === expectedUid).toBe(obs.customUidMatchesExpected);
      expect(customUser.isAnonymous).toBe(obs.customIsAnonymous);

      const tokenRes = await harness.sendOp({
        method: 'auth.getIdTokenResult',
        forceRefresh: true,
      });
      expect(tokenRes.ok).toBe(true);
      const tokenPayload = tokenRes.value as {
        signInProvider: string;
        claims: Record<string, unknown>;
      };
      expect(tokenPayload.signInProvider).toBe(obs.signInProvider);
      expect(tokenPayload.claims.role).toBe(obs.customClaimsRole);
      expect(tokenPayload.claims.tier).toBe(obs.customClaimsTier);

      const invalidRes = await harness.sendOp({
        method: 'auth.signInWithCustomToken',
        customToken: 'not-a-valid-jwt',
      });
      expect(invalidRes.ok).toBe(false);
      expect(invalidRes.error?.code).toBe('auth/invalid-custom-token');
      expect(obs.invalidCustomTokenMatchesEnum).toBe(true);
      expect(swiftErrorSource).toContain(`public let AuthErrorDomain = "${obs.invalidCustomTokenDomain}"`);
      expect(swiftErrorCodeSource).toContain(`case .invalidCustomToken: return ${obs.invalidCustomTokenCode}`);
      expect(swiftErrorCodeSource).toContain(
        `case .invalidCustomToken: return "${obs.invalidCustomTokenErrorName}"`,
      );

      expect((await harness.sendOp({ method: 'auth.signOut' })).ok).toBe(true);
      const afterSignOut = await harness.sendOp({ method: 'auth.getCurrentUser' });
      expect(afterSignOut.value === null).toBe(obs.currentUserNilAfterSignOut);
    } finally {
      await harness.close();
    }
  });

  test('auth-swift#6 auth-swift#8 auth-swift#26 auth-swift#31 auth-swift#53 auth-swift#54 replay createUser, signIn(withEmail:password:), and duplicate/wrong-password/invalid-email/missing-user FIRAuthErrorDomain codes', async () => {
    const obs = gate.load<AuthSwiftEmailPasswordAndErrorCodesObservation>(
      'auth-swift-email-password-and-error-codes',
    );
    const swiftErrorCodeSource = readFileSync(SWIFT_AUTH_ERROR_CODE_PATH, 'utf8');
    const swiftErrorSource = readFileSync(SWIFT_AUTH_ERROR_PATH, 'utf8');

    const harness = await openHostedKotlinBridge({
      projectId: `demo-swift-email-${Date.now()}`,
    });
    try {
      const email = 'ios-ep-replay@example.com';
      const missingEmail = 'ios-missing-replay@example.com';
      const validPassword = 'ValidPass!2468';

      const createdRes = await harness.sendOp({
        method: 'auth.createUser',
        email,
        password: validPassword,
      });
      expect(createdRes.ok).toBe(true);
      const createdUser = (createdRes.value as { user: HostedSwiftUserWire }).user;
      expect(createdUser.isAnonymous).toBe(obs.signUpIsAnonymous);
      expect(createdUser.email === email).toBe(obs.signUpEmailMatches);
      expect(Boolean(createdUser.emailVerified)).toBe(obs.signUpEmailVerified);

      const currentAfterSignUp = await harness.sendOp({ method: 'auth.getCurrentUser' });
      const currentSignUpUser = currentAfterSignUp.value as HostedSwiftUserWire | null;
      let matchesSignUpCurrent = false;
      if (currentSignUpUser !== null) {
        matchesSignUpCurrent = currentSignUpUser.uid === createdUser.uid;
      }
      expect(matchesSignUpCurrent).toBe(obs.currentUserMatchesAfterSignUp);

      const dupRes = await harness.sendOp({
        method: 'auth.createUser',
        email,
        password: 'OtherPass!1357',
      });
      expect(dupRes.ok).toBe(false);
      expect(dupRes.error?.code).toBe('auth/email-already-in-use');
      expect(obs.duplicateEmailMatchesEnum).toBe(true);
      expect(swiftErrorSource).toContain(`public let AuthErrorDomain = "${obs.duplicateEmailDomain}"`);
      expect(swiftErrorCodeSource).toContain(`case .emailAlreadyInUse: return ${obs.duplicateEmailCode}`);
      expect(swiftErrorCodeSource).toContain(
        `case .emailAlreadyInUse: return "${obs.duplicateEmailErrorName}"`,
      );

      expect((await harness.sendOp({ method: 'auth.signOut' })).ok).toBe(true);
      const signInRes = await harness.sendOp({
        method: 'auth.signInEmail',
        email,
        password: validPassword,
      });
      expect(signInRes.ok).toBe(true);
      const signedInUser = (signInRes.value as { user: HostedSwiftUserWire }).user;
      expect(signedInUser.uid === createdUser.uid).toBe(obs.signInUidMatchesSignUp);
      expect(signedInUser.isAnonymous).toBe(obs.signInIsAnonymous);

      const currentAfterSignIn = await harness.sendOp({ method: 'auth.getCurrentUser' });
      const currentSignInUser = currentAfterSignIn.value as HostedSwiftUserWire | null;
      let matchesSignInCurrent = false;
      if (currentSignInUser !== null) {
        matchesSignInCurrent = currentSignInUser.uid === createdUser.uid;
      }
      expect(matchesSignInCurrent).toBe(obs.currentUserMatchesAfterSignIn);

      expect((await harness.sendOp({ method: 'auth.signOut' })).ok).toBe(true);
      const wrongPassRes = await harness.sendOp({
        method: 'auth.signInEmail',
        email,
        password: 'WrongPass!9999',
      });
      expect(wrongPassRes.ok).toBe(false);
      expect(wrongPassRes.error?.code).toBe('auth/invalid-credential');
      expect(obs.wrongPasswordMatchesExpectedEnum).toBe(true);
      expect(obs.wrongPasswordDomain).toBe(obs.duplicateEmailDomain);
      expect(swiftErrorCodeSource).toContain(
        `case .invalidCredential, .noMockConfigured: return ${obs.wrongPasswordCode}`,
      );
      expect(swiftErrorCodeSource).toContain(
        `case .invalidCredential, .noMockConfigured: return "${obs.wrongPasswordErrorName}"`,
      );

      const invalidEmailRes = await harness.sendOp({
        method: 'auth.signInEmail',
        email: 'not-a-valid-email',
        password: validPassword,
      });
      expect(invalidEmailRes.ok).toBe(false);
      expect(invalidEmailRes.error?.code).toBe('auth/invalid-email');
      expect(obs.invalidEmailMatchesEnum).toBe(true);
      expect(obs.invalidEmailDomain).toBe(obs.duplicateEmailDomain);
      expect(swiftErrorCodeSource).toContain(`case .invalidEmail: return ${obs.invalidEmailCode}`);
      expect(swiftErrorCodeSource).toContain(
        `case .invalidEmail: return "${obs.invalidEmailErrorName}"`,
      );

      const userNotFoundRes = await harness.sendOp({
        method: 'auth.signInEmail',
        email: missingEmail,
        password: validPassword,
      });
      expect(userNotFoundRes.ok).toBe(false);
      expect(userNotFoundRes.error?.code).toBe('auth/invalid-credential');
      expect(obs.userNotFoundMatchesExpectedEnum).toBe(true);
      expect(obs.userNotFoundDomain).toBe(obs.wrongPasswordDomain);
      expect(obs.userNotFoundCode).toBe(obs.wrongPasswordCode);
      expect(obs.userNotFoundErrorName).toBe(obs.wrongPasswordErrorName);
    } finally {
      await harness.close();
    }
  });

  test('auth-swift#27 auth-swift#28 auth-swift#38 auth-swift#40 auth-swift#41 auth-swift#44 auth-swift#45 auth-swift#46 replay UserProfileChangeRequest / updateProfile, reload, AuthTokenResult JWT claims & dates, and User.delete()', async () => {
    const obs = gate.load<AuthSwiftProfileTokenClaimsAndDeleteObservation>(
      'auth-swift-profile-token-claims-and-delete-lifecycle',
    );
    const swiftUserSource = readFileSync(SWIFT_USER_PATH, 'utf8');
    const swiftProfileReqSource = readFileSync(SWIFT_PROFILE_REQUEST_PATH, 'utf8');
    const swiftTokenResultSource = readFileSync(SWIFT_AUTH_TOKEN_RESULT_PATH, 'utf8');
    const swiftLiveParitySource = readFileSync(SWIFT_LIVE_HOST_PARITY_TEST_PATH, 'utf8');

    expect(swiftUserSource).toContain('public func createProfileChangeRequest() -> UserProfileChangeRequest');
    expect(swiftUserSource).toContain('public func updateProfile(displayName: String?, photoURL: URL?) async throws');
    expect(swiftUserSource).toContain('public func reload() async throws');
    expect(swiftUserSource).toContain('public func delete() async throws');
    expect(swiftProfileReqSource).toContain('public func commitChanges() async throws');
    expect(swiftTokenResultSource).toContain('public let token: String');
    expect(swiftTokenResultSource).toContain('public let expirationDate: Date');
    expect(swiftTokenResultSource).toContain('public let authDate: Date');
    expect(swiftTokenResultSource).toContain('public let issuedAtDate: Date');
    expect(swiftLiveParitySource).toContain('try await profileReq.commitChanges()');
    expect(swiftLiveParitySource).toContain('try await toDelete.user.delete()');

    const harness = await openHostedKotlinBridge({
      projectId: `demo-swift-profile-${Date.now()}`,
    });
    try {
      const email = 'ios-prof-replay@example.com';
      const password = 'ValidPass!2468';

      const createdRes = await harness.sendOp({
        method: 'auth.createUser',
        email,
        password,
      });
      expect(createdRes.ok).toBe(true);
      const createdUser = (createdRes.value as { user: HostedSwiftUserWire }).user;
      expect(createdUser.displayName === null).toBe(obs.initialDisplayNameNil);
      expect(createdUser.photoURL === null).toBe(obs.initialPhotoUrlNil);

      const updateRes = await harness.sendOp({
        method: 'auth.updateProfile',
        displayName: obs.displayNameAfterCommit,
        photoURL: obs.photoUrlAfterCommit,
      });
      expect(updateRes.ok).toBe(true);
      const updatedUser = updateRes.value as HostedSwiftUserWire;
      expect(updatedUser.displayName).toBe(obs.displayNameAfterCommit);
      expect(updatedUser.photoURL).toBe(obs.photoUrlAfterCommit);

      const reloadRes = await harness.sendOp({ method: 'auth.reload', uid: createdUser.uid });
      expect(reloadRes.ok).toBe(true);
      const reloadedUser = reloadRes.value as HostedSwiftUserWire;
      expect(reloadedUser.displayName).toBe(obs.displayNameAfterReload);
      expect(reloadedUser.photoURL).toBe(obs.photoUrlAfterReload);

      const tokenRes = await harness.sendOp({
        method: 'auth.getIdTokenResult',
        forceRefresh: true,
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
      expect(tokenPayload.token.split('.').length).toBe(obs.jwtSegmentCount);
      expect(tokenPayload.signInProvider).toBe(obs.signInProvider);
      expect(Date.parse(tokenPayload.expirationTime) > Date.parse(tokenPayload.authTime)).toBe(
        obs.expirationAfterAuthDate,
      );
      expect(Date.parse(tokenPayload.issuedAtTime) / 1000 > 1_700_000_000).toBe(
        obs.issuedAtPresent,
      );
      expect(tokenPayload.claims.email === email).toBe(obs.claimEmailMatchesUser);
      expect(tokenPayload.claims.email_verified).toBe(obs.claimEmailVerified);
      expect(tokenPayload.claims.sub === createdUser.uid).toBe(obs.claimSubMatchesUid);
      expect(tokenPayload.claims.user_id === createdUser.uid).toBe(obs.claimUserIdMatchesUid);
      expect(tokenPayload.claims.name).toBe(obs.claimNameAfterProfileUpdate);
      expect(tokenPayload.claims.picture).toBe(obs.claimPictureAfterProfileUpdate);

      const firebaseClaim = tokenPayload.claims.firebase as
        | { sign_in_provider?: string; identities?: { email?: string[] } }
        | undefined;
      let fbProvider = '';
      let fbEmailCount = 0;
      if (firebaseClaim !== undefined) {
        if (typeof firebaseClaim.sign_in_provider === 'string') {
          fbProvider = firebaseClaim.sign_in_provider;
        }
        if (
          firebaseClaim.identities !== undefined &&
          Array.isArray(firebaseClaim.identities.email)
        ) {
          fbEmailCount = firebaseClaim.identities.email.length;
        }
      }
      expect(fbProvider).toBe(obs.firebaseSignInProvider);
      expect(fbEmailCount).toBe(obs.firebaseEmailIdentityCount);

      const deleteRes = await harness.sendOp({ method: 'auth.deleteUser' });
      expect(deleteRes.ok).toBe(true);
      const afterDelete = await harness.sendOp({ method: 'auth.getCurrentUser' });
      expect(afterDelete.value === null).toBe(obs.currentUserNilAfterDelete);

      const signInAfterDelete = await harness.sendOp({
        method: 'auth.signInEmail',
        email,
        password,
      });
      expect(!signInAfterDelete.ok).toBe(obs.signInAfterDeleteRejected);
      expect(signInAfterDelete.error?.code).toBe('auth/invalid-credential');
      expect(obs.signInAfterDeleteDomain).toBe('FIRAuthErrorDomain');
      expect(obs.signInAfterDeleteCode).toBe(17004);
      expect(obs.signInAfterDeleteErrorName).toBe('ERROR_INVALID_CREDENTIAL');
      expect(obs.signInAfterDeleteMatchesExpectedEnum).toBe(true);
    } finally {
      await harness.close();
    }
  });

  test('covers every Wave 1 and Wave 2 auth-swift observation through createObservationGate', () => {
    const report = gate.report();
    expect(report.committed).toEqual([
      'auth-swift-anonymous-and-custom-token-session',
      'auth-swift-email-password-and-error-codes',
      'auth-swift-profile-token-claims-and-delete-lifecycle',
    ]);
    expect(report.loadedButUnused).toEqual([]);
    expect(report.uncovered).toEqual([]);
  });
});
