import { join } from 'node:path';
import { REPO_ROOT } from '../../src/ledger.ts';

export interface SwiftProviderEntrySummary {
  providerID: string;
  uidNonEmpty: boolean;
  emailMatchesExpected: boolean;
  emailIsNil: boolean;
  displayNameIsNil: boolean;
  photoURLIsNil: boolean;
  phoneNumberIsNil: boolean;
}

export interface SwiftWave4FailureOutcome {
  threw: boolean;
  domain: string;
  code: number;
  errorName: string;
  matchesCollisionEnum?: boolean;
  matchesProviderAlreadyLinkedEnum?: boolean;
}

export interface AuthSwiftWave4Observation {
  defaultAuthSingletonIdentical: boolean;
  defaultAuthAppIsDefault: boolean;
  namedAuthSingletonIdentical: boolean;
  namedAuthAppMatchesConfigured: boolean;
  initialTenantIdNil: boolean;
  configuredTenantId: string;
  mainAppTenantIdNil: boolean;
  explicitLanguageCode: string;
  afterUseAppLanguageValid: boolean;
  asyncSequenceInitialStateNil: boolean;
  asyncSequenceInitialIdTokenNil: boolean;
  stateListenerInitialNil: boolean;
  stateListenerObservedTransitions: boolean;
  idTokenListenerMoreGranularOrEqual: boolean;
  silentAfterRemoveListeners: boolean;
  anonymousIsNewUser: boolean;
  existingSignInIsNewUser: boolean;
  anonymousTopLevelProviderID: string;
  anonymousPhoneNumberNil: boolean;
  anonymousUserTenantIdNil: boolean;
  anonymousMetadataHasDates: boolean;
  anonymousProviderEntries: SwiftProviderEntrySummary[];
  getIDTokenSegmentCountsValid: boolean;
  linkPreservedUid: boolean;
  linkedIsAnonymous: boolean;
  linkedEmailMatches: boolean;
  linkedPhoneNumberNil: boolean;
  linkedProviderEntries: SwiftProviderEntrySummary[];
  linkCollision: SwiftWave4FailureOutcome;
  alreadyLinkedProvider: SwiftWave4FailureOutcome;
  reauthenticatePreservedUid: boolean;
  updatedPasswordCredentialSameUid: boolean;
  unlinkedProviderIDs: string[];
  emailProviderConstant: string;
  googleCredentialProvider: string;
  githubOAuthProvider: string;
  githubOAuthHasIdAndAccessTokens: boolean;
  appleOAuthProvider: string;
  appleOAuthHasIdAndAccessTokens: boolean;
  customOidcProvider: string;
  googleSyntheticSignInOutcome: SwiftWave4FailureOutcome;
  appleSyntheticSignInOutcome: SwiftWave4FailureOutcome;
}

export interface HostedSwiftUserWire {
  uid: string;
  email: string | null;
  displayName?: string | null;
  photoURL?: string | null;
  phoneNumber: string | null;
  isAnonymous: boolean;
  emailVerified?: boolean;
  providerId?: string | null;
  tenantId?: string | null;
  providerData?: Array<{
    uid?: string;
    email?: string | null;
    displayName?: string | null;
    photoURL?: string | null;
    phoneNumber?: string | null;
    providerId?: string;
  }>;
}

export const WAVE4_AUTH_SWIFT_STEM =
  'auth-swift-instance-linking-reauth-and-oauth-credentials';

export const AUTH_SWIFT_OBSERVATIONS_DIR = join(
  REPO_ROOT,
  'packages',
  'conformance',
  'observations',
  'auth-swift',
);

const SWIFT_AUTH_SOURCES_DIR = join(
  REPO_ROOT,
  'packages',
  'swift-client',
  'Sources',
  'FirebaseAuth',
);

const SWIFT_LIVE_HOST_TESTS_DIR = join(
  REPO_ROOT,
  'packages',
  'swift-client',
  'Tests',
  'PyricLiveHostTests',
);

export const SWIFT_AUTH_PATH = join(SWIFT_AUTH_SOURCES_DIR, 'Auth.swift');
export const SWIFT_AUTH_ORACLE_PARITY_PATH = join(
  SWIFT_AUTH_SOURCES_DIR,
  'Auth+OracleParity.swift',
);
export const SWIFT_USER_PATH = join(SWIFT_AUTH_SOURCES_DIR, 'User.swift');
export const SWIFT_USER_METADATA_PATH = join(SWIFT_AUTH_SOURCES_DIR, 'UserMetadata.swift');
export const SWIFT_PROFILE_REQUEST_PATH = join(
  SWIFT_AUTH_SOURCES_DIR,
  'UserProfileChangeRequest.swift',
);
export const SWIFT_AUTH_DATA_RESULT_PATH = join(SWIFT_AUTH_SOURCES_DIR, 'AuthDataResult.swift');
export const SWIFT_ADDITIONAL_USER_INFO_PATH = join(
  SWIFT_AUTH_SOURCES_DIR,
  'AdditionalUserInfo.swift',
);
export const SWIFT_AUTH_TOKEN_RESULT_PATH = join(SWIFT_AUTH_SOURCES_DIR, 'AuthTokenResult.swift');
export const SWIFT_USER_INFO_IMPL_PATH = join(SWIFT_AUTH_SOURCES_DIR, 'UserInfoImpl.swift');
export const SWIFT_AUTH_ERROR_CODE_PATH = join(SWIFT_AUTH_SOURCES_DIR, 'AuthErrorCode.swift');
export const SWIFT_AUTH_ERROR_PATH = join(SWIFT_AUTH_SOURCES_DIR, 'AuthError.swift');
export const SWIFT_AUTH_STATE_SEQ_PATH = join(
  SWIFT_AUTH_SOURCES_DIR,
  'AuthStateChangesSequence.swift',
);
export const SWIFT_ID_TOKEN_SEQ_PATH = join(
  SWIFT_AUTH_SOURCES_DIR,
  'IDTokenChangesSequence.swift',
);
export const SWIFT_AUTH_CREDENTIAL_PATH = join(SWIFT_AUTH_SOURCES_DIR, 'AuthCredential.swift');
export const SWIFT_EMAIL_AUTH_PROVIDER_PATH = join(
  SWIFT_AUTH_SOURCES_DIR,
  'EmailAuthProvider.swift',
);
export const SWIFT_GOOGLE_AUTH_PROVIDER_PATH = join(
  SWIFT_AUTH_SOURCES_DIR,
  'GoogleAuthProvider.swift',
);
export const SWIFT_OAUTH_PROVIDER_PATH = join(SWIFT_AUTH_SOURCES_DIR, 'OAuthProvider.swift');
export const SWIFT_OAUTH_CREDENTIAL_PATH = join(SWIFT_AUTH_SOURCES_DIR, 'OAuthCredential.swift');

export const SWIFT_LIVE_HOST_AUTH_TEST_PATH = join(
  SWIFT_LIVE_HOST_TESTS_DIR,
  'AuthLiveHostConformanceTests.swift',
);
export const SWIFT_LIVE_HOST_PARITY_TEST_PATH = join(
  SWIFT_LIVE_HOST_TESTS_DIR,
  'AuthLiveHostOracleParityTests.swift',
);

export function normalizeSwiftTopLevelProviderID(raw: string | null | undefined): string {
  if (raw === undefined || raw === null || raw === '' || raw === 'firebase') {
    return 'Firebase';
  }
  return raw;
}

export function summarizeSwiftProviderData(
  user: HostedSwiftUserWire,
  expectedEmail: string | null,
): SwiftProviderEntrySummary[] {
  const entries: SwiftProviderEntrySummary[] = [];
  if (!Array.isArray(user.providerData)) {
    return entries;
  }
  for (const raw of user.providerData) {
    let providerID = 'password';
    if (typeof raw.providerId === 'string' && raw.providerId !== '') {
      providerID = raw.providerId;
    }
    let uid = '';
    if (typeof raw.uid === 'string') {
      uid = raw.uid;
    }
    let email: string | null = null;
    if (typeof raw.email === 'string') {
      email = raw.email;
    }
    const emailMatchesExpected =
      expectedEmail !== null &&
      email !== null &&
      email.toLowerCase() === expectedEmail.toLowerCase();
    entries.push({
      providerID,
      uidNonEmpty: uid.length > 0,
      emailMatchesExpected,
      emailIsNil: email === null,
      displayNameIsNil: raw.displayName === null || raw.displayName === undefined,
      photoURLIsNil: raw.photoURL === null || raw.photoURL === undefined,
      phoneNumberIsNil: raw.phoneNumber === null || raw.phoneNumber === undefined,
    });
  }
  return entries;
}
