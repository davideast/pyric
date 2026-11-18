import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'pyric-admin/app';
import { getAuth as getAdminAuth } from 'pyric-admin/auth';
import type { Sandbox } from 'pyric/sandbox';
import { observeAsyncAuthAttempt, observeSyncAuthAttempt } from './auth-user-probe-session.ts';
import type { Behavior, Pin } from './capture/sdk-scenarios/replay-comparison.ts';
import { waitForCondition } from './oracle-run-stable-shapes.ts';

interface ReplayUserShape {
  readonly uid: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly displayName: string | null;
  readonly photoURL: string | null;
  readonly phoneNumber: string | null;
  readonly isAnonymous: boolean;
  readonly tenantId: string | null;
}

interface ReplayAuthHandle {
  readonly app?: unknown;
  readonly currentUser: ReplayUserShape | null;
  tenantId: string | null;
}

export interface ReplayUserManagementAuthSdk {
  readonly inMemoryPersistence: unknown;
  getAuth(app: unknown): ReplayAuthHandle;
  initializeAuth(app: unknown, deps?: unknown): ReplayAuthHandle;
  signInWithEmailAndPassword(
    auth: ReplayAuthHandle,
    email: string,
    password: string,
  ): Promise<{ user: ReplayUserShape }>;
  signOut(auth: ReplayAuthHandle): Promise<void>;
  onAuthStateChanged(
    auth: ReplayAuthHandle,
    observer: (user: ReplayUserShape | null) => void,
  ): () => void;
  deleteUser(user: ReplayUserShape): Promise<void>;
  reload(user: ReplayUserShape): Promise<void>;
  updateCurrentUser(auth: ReplayAuthHandle, user: ReplayUserShape | null): Promise<void>;
}

interface ReplayUserManagementAdminAuth {
  createUser(props: {
    uid: string;
    email: string;
    password: string;
    displayName?: string;
    photoURL?: string;
    emailVerified?: boolean;
  }): Promise<unknown>;
  getUser(uid: string): Promise<unknown>;
  updateUser(
    uid: string,
    props: {
      displayName?: string | null;
      photoURL?: string | null;
      emailVerified?: boolean;
      disabled?: boolean;
    },
  ): Promise<unknown>;
  deleteUser(uid: string): Promise<void>;
}

export interface AuthUserManagementReplayContext {
  readonly auth: ReplayAuthHandle;
  readonly authSdk: ReplayUserManagementAuthSdk;
  readonly adminAuth: ReplayUserManagementAdminAuth;
  readonly FirebaseError: new (...args: never[]) => Error;
  createAuxiliaryApp(label: string): unknown;
  nextUid(label: string): string;
  nextEmail(label: string): string;
  cleanup(): Promise<void>;
}

export function createUserManagementAdminSession(sandbox: Sandbox, label: string): {
  readonly adminAuth: ReplayUserManagementAdminAuth;
  cleanup(): Promise<void>;
} {
  const adminApp = initializeAdminApp(
    { sandbox, projectId: 'demo-auth-user-management' },
    `admin-mgmt-${label}-${Math.random().toString(36).slice(2, 10)}`,
  );
  const adminAuth = getAdminAuth(adminApp) as unknown as ReplayUserManagementAdminAuth;
  return {
    adminAuth,
    cleanup: async () => {
      await deleteAdminApp(adminApp);
    },
  };
}

export const DELETE_USER_SIGNIN_ENUMERATION_PIN: Pin = {
  key: 'signInAfterDelete',
  finding:
    'auth#14 (#1819): Email Enumeration Protection answers auth/invalid-credential in production while Pyric throws auth/user-not-found',
  production: {
    threw: true,
    errorName: 'FirebaseError',
    isFirebaseError: true,
    code: 'auth/invalid-credential',
  },
  pyric: {
    threw: true,
    errorName: 'FirebaseError',
    isFirebaseError: true,
    code: 'auth/user-not-found',
  },
};

const PROBE_PASSWORD = 'ProbePassword!123';

export async function replayAuthInitializeAuthLifecycleAndDeps(
  ctx: AuthUserManagementReplayContext,
): Promise<Behavior> {
  try {
    const uid = ctx.nextUid('initauth');
    const email = ctx.nextEmail('initauth');
    await ctx.adminAuth.createUser({ uid, email, password: PROBE_PASSWORD });

    const appInitFirst = ctx.createAuxiliaryApp('init-first');
    const initializedHandle = ctx.authSdk.initializeAuth(appInitFirst, {
      persistence: ctx.authSdk.inMemoryPersistence,
    });
    const getAfterInit = ctx.authSdk.getAuth(appInitFirst);

    const cred = await ctx.authSdk.signInWithEmailAndPassword(
      initializedHandle,
      email,
      PROBE_PASSWORD,
    );
    const liveHandleWorks = {
      appMatches: initializedHandle.app === appInitFirst,
      getAuthReturnsSameHandle: getAfterInit === initializedHandle,
      currentUserMatchesSignedIn: initializedHandle.currentUser === cred.user,
      uidMatchesCreatedUser: cred.user.uid === uid,
    };
    await ctx.authSdk.signOut(initializedHandle);

    const secondInitNoDeps = observeSyncAuthAttempt(
      () => ctx.authSdk.initializeAuth(appInitFirst),
      ctx.FirebaseError,
    );
    const secondInitWithDeps = observeSyncAuthAttempt(
      () =>
        ctx.authSdk.initializeAuth(appInitFirst, {
          persistence: ctx.authSdk.inMemoryPersistence,
        }),
      ctx.FirebaseError,
    );

    const appGetFirstNoDeps = ctx.createAuxiliaryApp('get-first-nodeps');
    const getFirstA = ctx.authSdk.getAuth(appGetFirstNoDeps);
    let initAfterGetNoDepsSameHandle = false;
    const initAfterGetNoDeps = observeSyncAuthAttempt(() => {
      const result = ctx.authSdk.initializeAuth(appGetFirstNoDeps);
      initAfterGetNoDepsSameHandle = result === getFirstA;
    }, ctx.FirebaseError);

    const appGetFirstWithDeps = ctx.createAuxiliaryApp('get-first-deps');
    ctx.authSdk.getAuth(appGetFirstWithDeps);
    const initAfterGetWithDeps = observeSyncAuthAttempt(
      () =>
        ctx.authSdk.initializeAuth(appGetFirstWithDeps, {
          persistence: ctx.authSdk.inMemoryPersistence,
        }),
      ctx.FirebaseError,
    );

    return {
      liveHandleWorks,
      secondInitNoDeps,
      secondInitWithDeps,
      initAfterGetNoDeps: {
        ...initAfterGetNoDeps,
        returnsSameHandleAsGetAuth: initAfterGetNoDepsSameHandle,
      },
      initAfterGetWithDeps,
    };
  } finally {
    await ctx.cleanup();
  }
}

export async function replayAuthDeleteUserSignOutAndFollowupErrors(
  ctx: AuthUserManagementReplayContext,
): Promise<Behavior> {
  try {
    const uid = ctx.nextUid('deluser');
    const email = ctx.nextEmail('deluser');
    await ctx.adminAuth.createUser({ uid, email, password: PROBE_PASSWORD });

    const cred = await ctx.authSdk.signInWithEmailAndPassword(ctx.auth, email, PROBE_PASSWORD);
    const heldUser = cred.user;

    const observedStates: Array<'user' | 'null'> = [];
    const unsub = ctx.authSdk.onAuthStateChanged(ctx.auth, (current) => {
      if (current === null) {
        observedStates.push('null');
      } else {
        observedStates.push('user');
      }
    });
    await waitForCondition(() => observedStates.length >= 1, 2000);
    const countBeforeDelete = observedStates.length;

    await ctx.authSdk.deleteUser(heldUser);
    await waitForCondition(
      () => observedStates.slice(countBeforeDelete).includes('null'),
      2000,
    );
    unsub();

    let adminLookupCode: string | null = null;
    try {
      await ctx.adminAuth.getUser(uid);
    } catch (err) {
      const rawCode = (err as { code?: unknown }).code;
      if (typeof rawCode === 'string') {
        adminLookupCode = rawCode;
      }
    }

    const reloadAfterDelete = await observeAsyncAuthAttempt(
      () => ctx.authSdk.reload(heldUser),
      ctx.FirebaseError,
    );
    const signInAfterDelete = await observeAsyncAuthAttempt(
      () => ctx.authSdk.signInWithEmailAndPassword(ctx.auth, email, PROBE_PASSWORD),
      ctx.FirebaseError,
    );

    return {
      currentUserNullAfterDelete: ctx.auth.currentUser === null,
      firedNullAuthStateOnDelete: observedStates.slice(countBeforeDelete).includes('null'),
      adminLookupCodeAfterDelete: adminLookupCode,
      reloadAfterDelete,
      signInAfterDelete,
    };
  } finally {
    await ctx.cleanup();
  }
}

export async function replayAuthReloadOutOfBandAndDisabledDeleted(
  ctx: AuthUserManagementReplayContext,
): Promise<Behavior> {
  try {
    const uidA = ctx.nextUid('reload-ok');
    const emailA = ctx.nextEmail('reload-ok');
    await ctx.adminAuth.createUser({ uid: uidA, email: emailA, password: PROBE_PASSWORD });

    const credA = await ctx.authSdk.signInWithEmailAndPassword(ctx.auth, emailA, PROBE_PASSWORD);
    const heldA = credA.user;
    const beforeReload = {
      displayName: heldA.displayName,
      photoURL: heldA.photoURL,
      emailVerified: heldA.emailVerified,
    };

    await ctx.adminAuth.updateUser(uidA, {
      displayName: 'Reloaded Name',
      photoURL: 'https://example.com/reloaded.png',
      emailVerified: true,
    });
    await ctx.authSdk.reload(heldA);
    const afterReload = {
      sameCurrentUserRef: ctx.auth.currentUser === heldA,
      displayName: heldA.displayName,
      photoURL: heldA.photoURL,
      emailVerified: heldA.emailVerified,
    };
    await ctx.authSdk.signOut(ctx.auth);

    const uidDisabled = ctx.nextUid('reload-disabled');
    const emailDisabled = ctx.nextEmail('reload-disabled');
    await ctx.adminAuth.createUser({
      uid: uidDisabled,
      email: emailDisabled,
      password: PROBE_PASSWORD,
    });
    const credDisabled = await ctx.authSdk.signInWithEmailAndPassword(
      ctx.auth,
      emailDisabled,
      PROBE_PASSWORD,
    );
    const heldDisabled = credDisabled.user;
    const disabledStates: Array<'user' | 'null'> = [];
    const unsubDisabled = ctx.authSdk.onAuthStateChanged(ctx.auth, (current) => {
      if (current === null) {
        disabledStates.push('null');
      } else {
        disabledStates.push('user');
      }
    });
    await waitForCondition(() => disabledStates.length >= 1, 2000);
    const countBeforeDisabledReload = disabledStates.length;
    await ctx.adminAuth.updateUser(uidDisabled, { disabled: true });
    const disabledReloadAttempt = await observeAsyncAuthAttempt(
      () => ctx.authSdk.reload(heldDisabled),
      ctx.FirebaseError,
    );
    await waitForCondition(
      () =>
        ctx.auth.currentUser === null &&
        disabledStates.slice(countBeforeDisabledReload).includes('null'),
      1500,
    );
    unsubDisabled();
    const disabledCurrentUserNull = ctx.auth.currentUser === null;
    const disabledSawNull = disabledStates.slice(countBeforeDisabledReload).includes('null');
    if (ctx.auth.currentUser !== null) {
      await ctx.authSdk.signOut(ctx.auth);
    }

    const uidDeleted = ctx.nextUid('reload-deleted');
    const emailDeleted = ctx.nextEmail('reload-deleted');
    await ctx.adminAuth.createUser({
      uid: uidDeleted,
      email: emailDeleted,
      password: PROBE_PASSWORD,
    });
    const credDeleted = await ctx.authSdk.signInWithEmailAndPassword(
      ctx.auth,
      emailDeleted,
      PROBE_PASSWORD,
    );
    const heldDeleted = credDeleted.user;
    const deletedStates: Array<'user' | 'null'> = [];
    const unsubDeleted = ctx.authSdk.onAuthStateChanged(ctx.auth, (current) => {
      if (current === null) {
        deletedStates.push('null');
      } else {
        deletedStates.push('user');
      }
    });
    await waitForCondition(() => deletedStates.length >= 1, 2000);
    const countBeforeDeletedReload = deletedStates.length;
    await ctx.adminAuth.deleteUser(uidDeleted);
    const deletedReloadAttempt = await observeAsyncAuthAttempt(
      () => ctx.authSdk.reload(heldDeleted),
      ctx.FirebaseError,
    );
    await waitForCondition(
      () =>
        ctx.auth.currentUser === null &&
        deletedStates.slice(countBeforeDeletedReload).includes('null'),
      1500,
    );
    unsubDeleted();
    const deletedCurrentUserNull = ctx.auth.currentUser === null;
    const deletedSawNull = deletedStates.slice(countBeforeDeletedReload).includes('null');

    return {
      outOfBandUpdate: {
        beforeReload,
        afterReload,
      },
      disabledAccountReload: {
        attempt: disabledReloadAttempt,
        currentUserNullAfterFailure: disabledCurrentUserNull,
        firedNullAuthState: disabledSawNull,
      },
      deletedAccountReload: {
        attempt: deletedReloadAttempt,
        currentUserNullAfterFailure: deletedCurrentUserNull,
        firedNullAuthState: deletedSawNull,
      },
    };
  } finally {
    await ctx.cleanup();
  }
}

export async function replayAuthUpdateCurrentUserSetAndNullSignOut(
  ctx: AuthUserManagementReplayContext,
): Promise<Behavior> {
  try {
    const uid = ctx.nextUid('updcur');
    const email = ctx.nextEmail('updcur');
    await ctx.adminAuth.createUser({ uid, email, password: PROBE_PASSWORD });

    const primaryCred = await ctx.authSdk.signInWithEmailAndPassword(
      ctx.auth,
      email,
      PROBE_PASSWORD,
    );
    const sourceUser = primaryCred.user;

    const secondaryApp = ctx.createAuxiliaryApp('updcur-secondary');
    const secondaryAuth = ctx.authSdk.initializeAuth(secondaryApp, {
      persistence: ctx.authSdk.inMemoryPersistence,
    });

    const secondaryFires: Array<'null' | 'matched-uid' | 'other-uid'> = [];
    const unsubSecondary = ctx.authSdk.onAuthStateChanged(secondaryAuth, (u) => {
      if (u === null) {
        secondaryFires.push('null');
      } else if (u.uid === uid) {
        secondaryFires.push('matched-uid');
      } else {
        secondaryFires.push('other-uid');
      }
    });
    await waitForCondition(() => secondaryFires.length >= 1, 2000);
    const countBeforeSet = secondaryFires.length;

    await ctx.authSdk.updateCurrentUser(secondaryAuth, sourceUser);
    await waitForCondition(
      () => secondaryFires.slice(countBeforeSet).includes('matched-uid'),
      2000,
    );
    const afterSetUser = {
      currentUserNonNull: secondaryAuth.currentUser !== null,
      uidMatchesSource: secondaryAuth.currentUser?.uid === uid,
      clonesAcrossAuthInstances:
        secondaryAuth.currentUser !== null && secondaryAuth.currentUser !== sourceUser,
      firedMatchedUidTransition: secondaryFires.slice(countBeforeSet).includes('matched-uid'),
    };

    const countBeforeNull = secondaryFires.length;
    await ctx.authSdk.updateCurrentUser(secondaryAuth, null);
    await waitForCondition(
      () => secondaryFires.slice(countBeforeNull).includes('null'),
      2000,
    );
    unsubSecondary();
    const afterClearNull = {
      secondaryCurrentUserIsNull: secondaryAuth.currentUser === null,
      primaryCurrentUserIntact: ctx.auth.currentUser?.uid === uid,
      firedNullTransition: secondaryFires.slice(countBeforeNull).includes('null'),
    };

    const tenantApp = ctx.createAuxiliaryApp('updcur-tenant');
    const tenantAuth = ctx.authSdk.initializeAuth(tenantApp, {
      persistence: ctx.authSdk.inMemoryPersistence,
    });
    tenantAuth.tenantId = 'pyric-probe-tenant-mismatch';
    const tenantMismatchAttempt = await observeAsyncAuthAttempt(
      () => ctx.authSdk.updateCurrentUser(tenantAuth, sourceUser),
      ctx.FirebaseError,
    );

    return {
      afterSetUser,
      afterClearNull,
      tenantMismatchAttempt,
      tenantCurrentUserRemainsNull: tenantAuth.currentUser === null,
    };
  } finally {
    await ctx.cleanup();
  }
}
