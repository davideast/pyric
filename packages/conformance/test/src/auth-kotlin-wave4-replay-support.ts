import { join } from 'node:path';
import { REPO_ROOT } from '../../src/ledger.ts';

export interface ProviderEntrySummary {
  providerId: string;
  uidNonBlank: boolean;
  uidEqualsUserUid: boolean;
  emailMatchesExpected: boolean;
  emailIsNull: boolean;
  phoneNumberIsNull: boolean;
}

export interface Wave4AuthFailureOutcome {
  threw: boolean;
  exceptionClass: string;
  isCollisionSubclass: boolean;
  errorCode?: string;
  alreadyLinkedProviderMessage?: boolean;
}

export interface AuthKotlinWave4Observation {
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

export interface HostedUserWire {
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

export const OBSERVATION_STEM = 'auth-kotlin-instance-linking-reauth-and-oauth-credentials';

export const AUTH_KOTLIN_OBSERVATIONS_DIR = join(
  REPO_ROOT,
  'packages',
  'conformance',
  'observations',
  'auth-kotlin',
);

const KT_AUTH_MAIN_DIR = join(
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
);

export const KT_FIREBASE_AUTH_PATH = join(KT_AUTH_MAIN_DIR, 'FirebaseAuth.kt');
export const KT_AUTH_KTX_PATH = join(KT_AUTH_MAIN_DIR, 'Auth.kt');
export const KT_FIREBASE_USER_PATH = join(KT_AUTH_MAIN_DIR, 'FirebaseUser.kt');
export const KT_AUTH_CREDENTIAL_PATH = join(KT_AUTH_MAIN_DIR, 'AuthCredential.kt');
export const KT_GOOGLE_AUTH_PROVIDER_PATH = join(KT_AUTH_MAIN_DIR, 'GoogleAuthProvider.kt');
export const KT_GOOGLE_AUTH_CREDENTIAL_PATH = join(KT_AUTH_MAIN_DIR, 'GoogleAuthCredential.kt');
export const KT_OAUTH_PROVIDER_PATH = join(KT_AUTH_MAIN_DIR, 'OAuthProvider.kt');
export const KT_OAUTH_CREDENTIAL_PATH = join(KT_AUTH_MAIN_DIR, 'OAuthCredential.kt');
export const KT_EMAIL_AUTH_PROVIDER_PATH = join(KT_AUTH_MAIN_DIR, 'EmailAuthProvider.kt');

export const KT_LIVE_HOST_AUTH_TEST_PATH = join(
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

export function summarizeKotlinProviderData(
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

export function buildUnsignedOidcJwt(claims: Record<string, unknown>): string {
  const headerB64 = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }), 'utf8').toString(
    'base64url',
  );
  const payloadB64 = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${headerB64}.${payloadB64}.sig`;
}
