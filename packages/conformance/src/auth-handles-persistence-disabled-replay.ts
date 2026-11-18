import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'pyric-admin/app';
import { getAuth as getAdminAuth } from 'pyric-admin/auth';
import type { Sandbox } from 'pyric/sandbox';
import { observeAsyncAuthAttempt } from './auth-user-probe-session.ts';
import type { Behavior } from './capture/sdk-scenarios/replay-comparison.ts';

const PROBE_PASSWORD = 'ProbePassword!123';

interface ReplayHandleAuth {
  readonly app: unknown;
  readonly currentUser: { readonly uid: string } | null;
  signOut(): Promise<void>;
}

export interface ReplayHandlesPersistenceDisabledAuthSdk {
  readonly inMemoryPersistence: unknown;
  readonly browserSessionPersistence: unknown;
  readonly browserLocalPersistence: unknown;
  readonly SAMLAuthProvider: new (providerId: string) => unknown;
  getAuth(app?: unknown): ReplayHandleAuth;
  signInWithEmailAndPassword(
    auth: ReplayHandleAuth,
    email: string,
    password: string,
  ): Promise<{ readonly user: { readonly uid: string } }>;
  signInWithCustomToken(
    auth: ReplayHandleAuth,
    token: string,
  ): Promise<{ readonly user: { readonly uid: string } }>;
  signOut(auth: ReplayHandleAuth): Promise<void>;
  getIdToken(user: { readonly uid: string }, forceRefresh?: boolean): Promise<string>;
  setPersistence(auth: ReplayHandleAuth, persistence: unknown): Promise<void>;
}

interface ReplayHandlesAdminAuth {
  createUser(properties: {
    readonly uid: string;
    readonly email: string;
    readonly password: string;
  }): Promise<unknown>;
  updateUser(uid: string, properties: { readonly disabled: boolean }): Promise<unknown>;
  createCustomToken(uid: string): Promise<string>;
}

export interface AuthHandlesPersistenceDisabledReplayContext {
  readonly auth: ReplayHandleAuth;
  readonly authSdk: ReplayHandlesPersistenceDisabledAuthSdk;
  readonly adminAuth: ReplayHandlesAdminAuth;
  readonly FirebaseError: new (code: string, message: string) => Error;
  createAuxiliaryClientApp(label: string): unknown;
  nextUid(label: string): string;
  nextEmail(label: string): string;
  cleanup(): Promise<void>;
}

export function createHandlesAdminSession(
  sandbox: Sandbox,
  projectId: string,
  label: string,
): {
  readonly adminAuth: ReplayHandlesAdminAuth;
  cleanup(): Promise<void>;
} {
  const adminApp = initializeAdminApp(
    { sandbox, projectId },
    `admin-handles-${label}-${Math.random().toString(36).slice(2, 10)}`,
  );
  const adminAuth = getAdminAuth(adminApp) as unknown as ReplayHandlesAdminAuth;
  return {
    adminAuth,
    cleanup: async () => {
      await deleteAdminApp(adminApp);
    },
  };
}

interface ObservedFirebaseErrorShape {
  readonly threw: boolean;
  readonly isFirebaseError: boolean;
  readonly isError: boolean;
  readonly name: string | null;
  readonly code: string | null;
  readonly startsWithFirebasePrefix: boolean;
  readonly endsWithWrappedCode: boolean;
}

function inspectErrorShape(
  err: unknown,
  firebaseErrorCtor: new (code: string, message: string) => Error,
): ObservedFirebaseErrorShape {
  const isFb = err instanceof firebaseErrorCtor;
  const isErr = err instanceof Error;
  const candidate = err as { name?: unknown; code?: unknown; message?: unknown };
  let name: string | null = null;
  if (typeof candidate?.name === 'string') {
    name = candidate.name;
  }
  let code: string | null = null;
  if (typeof candidate?.code === 'string') {
    code = candidate.code;
  }
  let startsWithFirebasePrefix = false;
  let endsWithWrappedCode = false;
  if (typeof candidate?.message === 'string') {
    startsWithFirebasePrefix = candidate.message.startsWith('Firebase: ');
    if (code !== null) {
      endsWithWrappedCode = candidate.message.endsWith(`(${code}).`);
    }
  }
  return {
    threw: true,
    isFirebaseError: isFb,
    isError: isErr,
    name,
    code,
    startsWithFirebasePrefix,
    endsWithWrappedCode,
  };
}

export async function replayAuthHandleCachingLiveCurrentUserAndReSignIn(
  ctx: AuthHandlesPersistenceDisabledReplayContext,
): Promise<Behavior> {
  try {
    const { adminAuth, auth, authSdk } = ctx;
    const sameAppReturnsSameHandle = authSdk.getAuth(auth.app) === auth;
    const auxApp = ctx.createAuxiliaryClientApp('handle-cache');
    const auxAuth1 = authSdk.getAuth(auxApp);
    const auxAuth2 = authSdk.getAuth(auxApp);
    const distinctAppReturnsDistinctHandle = auxAuth1 !== auth;
    const auxSameAppReturnsSameHandle = auxAuth1 === auxAuth2;

    const uid = ctx.nextUid('resignin');
    const email = ctx.nextEmail('resignin');
    await adminAuth.createUser({ uid, email, password: PROBE_PASSWORD });

    const heldAuth = auth;
    const initialCurrentUserNull = heldAuth.currentUser === null;

    const cred1 = await authSdk.signInWithEmailAndPassword(heldAuth, email, PROBE_PASSWORD);
    const firstSignInMatchesSeededUid = cred1.user.uid === uid;
    const liveGetterReadsSignedInUid = heldAuth.currentUser?.uid === uid;

    const methodSignOutResult = await heldAuth.signOut();
    const methodSignOutResolvesUndefined = methodSignOutResult === undefined;
    const liveGetterNullAfterMethodSignOut = heldAuth.currentUser === null;

    const cred2 = await authSdk.signInWithEmailAndPassword(heldAuth, email, PROBE_PASSWORD);
    const reSignInReturnsSameUid = cred2.user.uid === uid;
    const liveGetterReadsReSignedInUid = heldAuth.currentUser?.uid === uid;

    const freeSignOutResult = await authSdk.signOut(heldAuth);
    const freeSignOutResolvesUndefined = freeSignOutResult === undefined;
    const liveGetterNullAfterFreeSignOut = heldAuth.currentUser === null;

    return {
      handleCaching: {
        sameAppReturnsSameHandle,
        distinctAppReturnsDistinctHandle,
        auxSameAppReturnsSameHandle,
      },
      liveCurrentUserAndReSignIn: {
        initialCurrentUserNull,
        firstSignInMatchesSeededUid,
        liveGetterReadsSignedInUid,
        methodSignOutResolvesUndefined,
        liveGetterNullAfterMethodSignOut,
        reSignInReturnsSameUid,
        liveGetterReadsReSignedInUid,
        freeSignOutResolvesUndefined,
        liveGetterNullAfterFreeSignOut,
      },
    };
  } finally {
    await ctx.cleanup();
  }
}

export async function replayAuthSetPersistenceAndFirebaseErrorWrapper(
  ctx: AuthHandlesPersistenceDisabledReplayContext,
): Promise<Behavior> {
  try {
    const { FirebaseError, auth, authSdk } = ctx;

    const memPromise = authSdk.setPersistence(auth, authSdk.inMemoryPersistence);
    const inMemoryIsPromise = memPromise instanceof Promise;
    const inMemoryResolvesUndefined = (await memPromise) === undefined;

    const sessionPromise = authSdk.setPersistence(auth, authSdk.browserSessionPersistence);
    const sessionIsPromise = sessionPromise instanceof Promise;
    const sessionResolvesUndefined = (await sessionPromise) === undefined;

    const localPromise = authSdk.setPersistence(auth, authSdk.browserLocalPersistence);
    const localIsPromise = localPromise instanceof Promise;
    const localResolvesUndefined = (await localPromise) === undefined;

    let syncErrorShape: ObservedFirebaseErrorShape = {
      threw: false,
      isFirebaseError: false,
      isError: false,
      name: null,
      code: null,
      startsWithFirebasePrefix: false,
      endsWithWrappedCode: false,
    };
    try {
      new authSdk.SAMLAuthProvider('missing-saml-prefix');
    } catch (err) {
      syncErrorShape = inspectErrorShape(err, FirebaseError);
    }

    let asyncInvalidEmailShape: ObservedFirebaseErrorShape = {
      threw: false,
      isFirebaseError: false,
      isError: false,
      name: null,
      code: null,
      startsWithFirebasePrefix: false,
      endsWithWrappedCode: false,
    };
    try {
      await authSdk.signInWithEmailAndPassword(auth, 'not-an-email', 'Secret!123');
    } catch (err) {
      asyncInvalidEmailShape = inspectErrorShape(err, FirebaseError);
    }

    return {
      setPersistenceMarkers: {
        inMemoryIsPromise,
        inMemoryResolvesUndefined,
        sessionIsPromise,
        sessionResolvesUndefined,
        localIsPromise,
        localResolvesUndefined,
      },
      firebaseErrorShape: {
        syncArgumentError: syncErrorShape,
        asyncInvalidEmail: asyncInvalidEmailShape,
      },
    };
  } finally {
    await ctx.cleanup();
  }
}

export async function replayAuthDisabledAccountSignInAndRefresh(
  ctx: AuthHandlesPersistenceDisabledReplayContext,
): Promise<Behavior> {
  try {
    const { FirebaseError, adminAuth, auth, authSdk } = ctx;
    const uid = ctx.nextUid('disabled');
    const email = ctx.nextEmail('disabled');
    await adminAuth.createUser({ uid, email, password: PROBE_PASSWORD });

    const signedIn = await authSdk.signInWithEmailAndPassword(auth, email, PROBE_PASSWORD);
    const signedInBeforeDisable = auth.currentUser?.uid === uid;

    await adminAuth.updateUser(uid, { disabled: true });
    const heldSessionStillPresentBeforeRefresh = auth.currentUser?.uid === uid;

    const forcedRefreshAfterDisable = await observeAsyncAuthAttempt(
      () => authSdk.getIdToken(signedIn.user, true),
      FirebaseError,
    );
    const signedOutAfterDisabledRefresh = auth.currentUser === null;

    const signInRightPasswordDisabled = await observeAsyncAuthAttempt(
      () => authSdk.signInWithEmailAndPassword(auth, email, PROBE_PASSWORD),
      FirebaseError,
    );
    const signInWrongPasswordDisabled = await observeAsyncAuthAttempt(
      () => authSdk.signInWithEmailAndPassword(auth, email, 'DefinitelyWrong!999'),
      FirebaseError,
    );
    const customToken = await adminAuth.createCustomToken(uid);
    const signInCustomTokenDisabled = await observeAsyncAuthAttempt(
      () => authSdk.signInWithCustomToken(auth, customToken),
      FirebaseError,
    );
    const remainsSignedOutAfterRejectedSignIns = auth.currentUser === null;

    return {
      signedInBeforeDisable,
      heldSessionStillPresentBeforeRefresh,
      forcedRefreshAfterDisable,
      signedOutAfterDisabledRefresh,
      signInRightPasswordDisabled,
      signInWrongPasswordDisabled,
      signInCustomTokenDisabled,
      remainsSignedOutAfterRejectedSignIns,
    };
  } finally {
    await ctx.cleanup();
  }
}
