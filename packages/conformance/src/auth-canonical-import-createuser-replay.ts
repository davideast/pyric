import { deleteApp as deleteCanonicalApp, initializeApp as initializeCanonicalApp } from 'firebase/app';
import * as canonicalFirebaseAuth from 'firebase/auth';
import type { Behavior } from './capture/sdk-scenarios/replay-comparison.ts';

const PROBE_PASSWORD = 'ProbePassword!123';

interface ReplayCreateUser {
  readonly uid: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly photoURL: string | null;
  readonly phoneNumber: string | null;
  readonly emailVerified: boolean;
  readonly isAnonymous: boolean;
  readonly providerData: ReadonlyArray<{ readonly providerId: string }>;
}

interface ReplayCreateUserCredential {
  readonly user: ReplayCreateUser;
  readonly operationType?: string;
  readonly providerId: string | null;
}

interface ReplayCreateUserAuth {
  readonly currentUser: ReplayCreateUser | null;
}

export interface ReplayCreateUserAuthSdk {
  createUserWithEmailAndPassword(
    auth: ReplayCreateUserAuth,
    email: string,
    password: string,
  ): Promise<ReplayCreateUserCredential>;
}

export interface AuthCanonicalImportCreateUserReplayContext {
  readonly auth: ReplayCreateUserAuth;
  readonly authSdk: ReplayCreateUserAuthSdk;
  nextEmail(label: string): string;
  cleanup(): Promise<void>;
}

let canonicalAppSeq = 0;

async function observeCanonicalFirebaseImportBoundary(): Promise<{
  readonly getAuthIsFunction: boolean;
  readonly hasSandboxNamespaceOnModule: boolean;
  readonly hasMockSignInResultOnModule: boolean;
  readonly hasTakeAuthMailOnModule: boolean;
  readonly hasSandboxPropertyOnAuth: boolean;
  readonly apiHost: string | null;
  readonly authNameMatchesAppName: boolean;
}> {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    fetchCalls += 1;
    return originalFetch(...args);
  }) as typeof fetch;

  canonicalAppSeq += 1;
  const canonicalApp = initializeCanonicalApp(
    {
      apiKey: 'AIzaSyDummyCanonicalImportKey00000000000',
      authDomain: 'demo-canonical-import.firebaseapp.com',
      projectId: 'demo-canonical-import',
      appId: '1:0:web:0',
    },
    `canonical-import-boundary-${canonicalAppSeq}`,
  );

  try {
    const canonicalAuth = canonicalFirebaseAuth.getAuth(canonicalApp);
    await canonicalAuth.authStateReady();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 15);
    });
    if (fetchCalls !== 0) {
      throw new Error(`Expected 0 fetch calls during canonical getAuth, observed ${fetchCalls}`);
    }

    const authConfig = (canonicalAuth as unknown as { config?: { apiHost?: unknown } }).config;
    let resolvedApiHost: string | null = null;
    if (typeof authConfig?.apiHost === 'string') {
      resolvedApiHost = authConfig.apiHost;
    }

    return {
      getAuthIsFunction: typeof canonicalFirebaseAuth.getAuth === 'function',
      hasSandboxNamespaceOnModule: 'sandbox' in canonicalFirebaseAuth,
      hasMockSignInResultOnModule: 'mockSignInResult' in canonicalFirebaseAuth,
      hasTakeAuthMailOnModule: 'takeAuthMail' in canonicalFirebaseAuth,
      hasSandboxPropertyOnAuth: 'sandbox' in (canonicalAuth as unknown as Record<string, unknown>),
      apiHost: resolvedApiHost,
      authNameMatchesAppName: canonicalAuth.name === canonicalAuth.app.name,
    };
  } finally {
    globalThis.fetch = originalFetch;
    await deleteCanonicalApp(canonicalApp).catch(() => undefined);
  }
}

export async function replayAuthCanonicalImportAndCreateUserShape(
  context: AuthCanonicalImportCreateUserReplayContext,
): Promise<Behavior> {
  const { auth, authSdk, nextEmail, cleanup } = context;
  try {
    const canonicalImportBoundary = await observeCanonicalFirebaseImportBoundary();
    const inputEmail = nextEmail('create-shape');
    const cred = await authSdk.createUserWithEmailAndPassword(auth, inputEmail, PROBE_PASSWORD);
    const currentUserUidMatchesCreatedUid =
      auth.currentUser?.uid === cred.user.uid && cred.user.uid.length > 0;
    let operationType: string | null = null;
    if (typeof cred.operationType === 'string') {
      operationType = cred.operationType;
    }

    return {
      canonicalImportBoundary,
      createUserAutoSignInAndShape: {
        autoSignedInAsCurrentUser: auth.currentUser === cred.user,
        currentUserUidMatchesCreatedUid,
        operationType,
        credentialProviderId: cred.providerId,
        userShape: {
          isAnonymous: cred.user.isAnonymous,
          emailMatchesInput: cred.user.email === inputEmail,
          displayName: cred.user.displayName,
          photoURL: cred.user.photoURL,
          phoneNumber: cred.user.phoneNumber,
          emailVerified: cred.user.emailVerified,
          providerIds: cred.user.providerData.map((entry) => entry.providerId),
        },
      },
    };
  } finally {
    await cleanup();
  }
}
