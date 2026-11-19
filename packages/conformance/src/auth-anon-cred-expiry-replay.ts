import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'pyric-admin/app';
import { getAuth as getAdminAuth } from 'pyric-admin/auth';
import type { Sandbox } from 'pyric/sandbox';
import { decodeJwtParts, observeAsyncAuthAttempt } from './auth-user-probe-session.ts';
import type { Behavior } from './capture/sdk-scenarios/replay-comparison.ts';
import { waitForCondition } from './oracle-run-stable-shapes.ts';

const PROBE_PASSWORD = 'ProbePassword!123';
const BEFORE_BUFFER_ADVANCE_MS = 3_555_000;
const INSIDE_BUFFER_ADVANCE_MS = 30_000;

interface ReplayAnonCredExpiryUser {
  readonly uid: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly photoURL: string | null;
  readonly emailVerified: boolean;
  readonly isAnonymous: boolean;
  readonly providerData: ReadonlyArray<{ readonly providerId: string }>;
  getIdToken(forceRefresh?: boolean): Promise<string>;
}

interface ReplayAnonCredExpiryCredential {
  readonly user: ReplayAnonCredExpiryUser;
  readonly operationType?: string;
  readonly providerId: string | null;
}

interface ReplayAnonCredExpiryAuth {
  readonly currentUser: ReplayAnonCredExpiryUser | null;
}

export interface ReplayAnonCredExpiryAuthSdk {
  readonly EmailAuthProvider: {
    credential(email: string, password: string): unknown;
  };
  signInAnonymously(auth: ReplayAnonCredExpiryAuth): Promise<ReplayAnonCredExpiryCredential>;
  signInWithEmailAndPassword(
    auth: ReplayAnonCredExpiryAuth,
    email: string,
    password: string,
  ): Promise<ReplayAnonCredExpiryCredential>;
  signInWithCredential(
    auth: ReplayAnonCredExpiryAuth,
    credential: unknown,
  ): Promise<ReplayAnonCredExpiryCredential>;
  signOut(auth: ReplayAnonCredExpiryAuth): Promise<void>;
  onAuthStateChanged(
    auth: ReplayAnonCredExpiryAuth,
    callback: (user: ReplayAnonCredExpiryUser | null) => void,
  ): () => void;
  onIdTokenChanged(
    auth: ReplayAnonCredExpiryAuth,
    callback: (user: ReplayAnonCredExpiryUser | null) => void,
  ): () => void;
}

interface ReplayAnonCredExpiryAdminAuth {
  createUser(properties: {
    readonly uid: string;
    readonly email: string;
    readonly password: string;
    readonly displayName?: string;
    readonly photoURL?: string;
    readonly emailVerified?: boolean;
    readonly disabled?: boolean;
  }): Promise<unknown>;
  setCustomUserClaims(
    uid: string,
    customUserClaims: Record<string, unknown> | null,
  ): Promise<void>;
}

export interface AuthAnonCredExpiryReplayContext {
  readonly auth: ReplayAnonCredExpiryAuth;
  readonly authSdk: ReplayAnonCredExpiryAuthSdk;
  readonly adminAuth: ReplayAnonCredExpiryAdminAuth;
  readonly FirebaseError: new (code: string, message: string) => Error;
  advanceClock(ms: number): Promise<void>;
  settle(): Promise<void>;
  nextUid(label: string): string;
  nextEmail(label: string): string;
  cleanup(): Promise<void>;
}

export function createAnonCredExpiryAdminSession(
  sandbox: Sandbox,
  projectId: string,
  label: string,
): {
  readonly adminAuth: ReplayAnonCredExpiryAdminAuth;
  cleanup(): Promise<void>;
} {
  const randomSuffix = Math.random().toString(36).slice(2, 10);
  const adminApp = initializeAdminApp(
    { sandbox, projectId },
    `admin-anon-cred-expiry-${label}-${randomSuffix}`,
  );
  const adminAuth = getAdminAuth(adminApp) as unknown as ReplayAnonCredExpiryAdminAuth;
  return {
    adminAuth,
    cleanup: async () => {
      await deleteAdminApp(adminApp);
    },
  };
}

export async function replayAuthGetIdTokenExpiryBufferRefresh(
  context: AuthAnonCredExpiryReplayContext,
): Promise<Behavior> {
  const { auth, authSdk, adminAuth, advanceClock, settle, nextUid, nextEmail, cleanup } =
    context;
  let unsubIdToken: (() => void) | null = null;
  let unsubAuthState: (() => void) | null = null;
  try {
    const uid = nextUid('token-expiry');
    const email = nextEmail('token-expiry');
    await adminAuth.createUser({ uid, email, password: PROBE_PASSWORD });

    const cred = await authSdk.signInWithEmailAndPassword(auth, email, PROBE_PASSWORD);
    const token0 = await cred.user.getIdToken();
    const jwt0 = decodeJwtParts(token0);
    const initialExpMinusIatSeconds =
      Number(jwt0.payload.exp) - Number(jwt0.payload.iat);

    let idTokenFires = 0;
    let authStateFires = 0;
    unsubIdToken = authSdk.onIdTokenChanged(auth, () => {
      idTokenFires += 1;
    });
    unsubAuthState = authSdk.onAuthStateChanged(auth, () => {
      authStateFires += 1;
    });

    await waitForCondition(() => idTokenFires >= 1 && authStateFires >= 1, 5000);
    if (idTokenFires < 1 || authStateFires < 1) {
      throw new Error(
        'Initial onIdTokenChanged or onAuthStateChanged emission did not arrive within 5000ms.',
      );
    }

    await adminAuth.setCustomUserClaims(uid, { refreshProbeStage: 'post-expiry' });

    const idTokenBaselineBefore = idTokenFires;
    const authStateBaselineBefore = authStateFires;
    await advanceClock(BEFORE_BUFFER_ADVANCE_MS);
    const tokenBeforeBuffer = await cred.user.getIdToken();
    await settle();
    const jwtBeforeBuffer = decodeJwtParts(tokenBeforeBuffer);
    const beforeRefreshBuffer = {
      returnedCachedToken: tokenBeforeBuffer === token0,
      carriesUpdatedClaim: jwtBeforeBuffer.payload.refreshProbeStage === 'post-expiry',
      idTokenChangedFires: idTokenFires - idTokenBaselineBefore,
      authStateChangedFires: authStateFires - authStateBaselineBefore,
    };

    const idTokenBaselineInside = idTokenFires;
    const authStateBaselineInside = authStateFires;
    await advanceClock(INSIDE_BUFFER_ADVANCE_MS);
    const tokenInsideBuffer = await cred.user.getIdToken();
    await waitForCondition(() => idTokenFires > idTokenBaselineInside, 5000);
    if (idTokenFires <= idTokenBaselineInside) {
      throw new Error(
        'onIdTokenChanged did not emit after non-forced refresh inside the 30s expiry buffer.',
      );
    }
    await settle();

    const jwtInsideBuffer = decodeJwtParts(tokenInsideBuffer);
    const tokenSubsequentCached = await cred.user.getIdToken();
    const insideRefreshBuffer = {
      mintedFreshToken: tokenInsideBuffer !== token0,
      carriesUpdatedClaim: jwtInsideBuffer.payload.refreshProbeStage === 'post-expiry',
      refreshedExpMinusIatSeconds:
        Number(jwtInsideBuffer.payload.exp) - Number(jwtInsideBuffer.payload.iat),
      idTokenChangedFires: idTokenFires - idTokenBaselineInside,
      authStateChangedFires: authStateFires - authStateBaselineInside,
      subsequentReadReturnsNewCachedToken: tokenSubsequentCached === tokenInsideBuffer,
    };

    return {
      initialExpMinusIatSeconds,
      beforeRefreshBuffer,
      insideRefreshBuffer,
    };
  } finally {
    if (unsubIdToken !== null) {
      unsubIdToken();
    }
    if (unsubAuthState !== null) {
      unsubAuthState();
    }
    await cleanup();
  }
}

export async function replayAuthAnonymousIdempotencyAndRemint(
  context: AuthAnonCredExpiryReplayContext,
): Promise<Behavior> {
  const { auth, authSdk, cleanup } = context;
  try {
    const cred1 = await authSdk.signInAnonymously(auth);
    const currentUserAfterFirst = auth.currentUser;
    const token1 = await cred1.user.getIdToken();
    const jwt1 = decodeJwtParts(token1);
    const firebaseClaim = jwt1.payload.firebase as
      | { sign_in_provider?: unknown }
      | undefined;
    let tokenSignInProvider: string | null = null;
    if (typeof firebaseClaim?.sign_in_provider === 'string') {
      tokenSignInProvider = firebaseClaim.sign_in_provider;
    }

    const cred2 = await authSdk.signInAnonymously(auth);
    const currentUserAfterRepeat = auth.currentUser;

    await authSdk.signOut(auth);
    const currentUserNullAfterSignOut = auth.currentUser === null;

    const cred3 = await authSdk.signInAnonymously(auth);

    return {
      initialSignIn: {
        setsCurrentUser: currentUserAfterFirst === cred1.user,
        isAnonymous: cred1.user.isAnonymous,
        email: cred1.user.email,
        displayName: cred1.user.displayName,
        tokenSubMatchesUid: jwt1.payload.sub === cred1.user.uid,
        tokenUserIdMatchesUid: jwt1.payload.user_id === cred1.user.uid,
        tokenSignInProvider,
      },
      repeatWhileSignedIn: {
        sameUid: cred2.user.uid === cred1.user.uid,
        sameUserRef: cred2.user === cred1.user,
        currentUserUnchanged: currentUserAfterRepeat === cred1.user,
        operationType: cred2.operationType ?? null,
        providerId: cred2.providerId,
      },
      afterSignOut: {
        currentUserNullAfterSignOut,
        mintedFreshUid: cred3.user.uid !== cred1.user.uid && cred3.user.uid.length > 0,
        isAnonymous: cred3.user.isAnonymous,
        setsCurrentUser: auth.currentUser === cred3.user,
      },
    };
  } finally {
    await cleanup();
  }
}

export async function replayAuthCredentialSignInRichUserAndDisabledGuard(
  context: AuthAnonCredExpiryReplayContext,
): Promise<Behavior> {
  const { auth, authSdk, adminAuth, FirebaseError, settle, nextUid, nextEmail, cleanup } =
    context;
  let unsubState: (() => void) | null = null;
  try {
    const uidActive = nextUid('cred-rich');
    const emailActive = nextEmail('cred-rich');
    await adminAuth.createUser({
      uid: uidActive,
      email: emailActive,
      password: PROBE_PASSWORD,
      displayName: 'Rich Profile User',
      photoURL: 'https://example.com/rich-avatar.png',
      emailVerified: true,
    });

    const credActive = await authSdk.signInWithCredential(
      auth,
      authSdk.EmailAuthProvider.credential(emailActive, PROBE_PASSWORD),
    );
    const richCredentialSignIn = {
      credUserSameRefAsCurrentUser: credActive.user === auth.currentUser,
      emailMatchesSeeded: credActive.user.email === emailActive,
      displayName: credActive.user.displayName,
      photoURL: credActive.user.photoURL,
      emailVerified: credActive.user.emailVerified,
      isAnonymous: credActive.user.isAnonymous,
      providerIds: credActive.user.providerData.map((entry) => entry.providerId),
    };

    const uidDisabled = nextUid('cred-disabled');
    const emailDisabled = nextEmail('cred-disabled');
    await adminAuth.createUser({
      uid: uidDisabled,
      email: emailDisabled,
      password: PROBE_PASSWORD,
      disabled: true,
    });

    let stateEmissionCount = 0;
    unsubState = authSdk.onAuthStateChanged(auth, () => {
      stateEmissionCount += 1;
    });
    await waitForCondition(() => stateEmissionCount >= 1, 5000);
    if (stateEmissionCount < 1) {
      throw new Error('Initial onAuthStateChanged emission did not arrive within 5000ms.');
    }

    const baselineCount = stateEmissionCount;
    const disabledWhileSignedInAttempt = await observeAsyncAuthAttempt(
      () =>
        authSdk.signInWithCredential(
          auth,
          authSdk.EmailAuthProvider.credential(emailDisabled, PROBE_PASSWORD),
        ),
      FirebaseError,
    );
    await settle();
    const currentUserPreservedRef = auth.currentUser === credActive.user;
    let currentUserPreservedUid = false;
    if (auth.currentUser !== null) {
      currentUserPreservedUid = auth.currentUser.uid === uidActive;
    }
    const authStateTransitionsDuringFailure = stateEmissionCount - baselineCount;
    unsubState();
    unsubState = null;

    await authSdk.signOut(auth);
    const disabledWhenSignedOutAttempt = await observeAsyncAuthAttempt(
      () =>
        authSdk.signInWithCredential(
          auth,
          authSdk.EmailAuthProvider.credential(emailDisabled, PROBE_PASSWORD),
        ),
      FirebaseError,
    );

    return {
      richCredentialSignIn,
      disabledCredentialSignInWhileSignedIn: {
        attempt: disabledWhileSignedInAttempt,
        currentUserPreservedRef,
        currentUserPreservedUid,
        authStateTransitionsDuringFailure,
      },
      disabledCredentialSignInWhenSignedOut: {
        attempt: disabledWhenSignedOutAttempt,
        currentUserStaysNull: auth.currentUser === null,
      },
    };
  } finally {
    if (unsubState !== null) {
      unsubState();
    }
    await cleanup();
  }
}
