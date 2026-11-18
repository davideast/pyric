import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'pyric-admin/app';
import { getAuth as getAdminAuth } from 'pyric-admin/auth';
import type { Sandbox } from 'pyric/sandbox';
import { observeAsyncAuthAttempt } from './auth-user-probe-session.ts';
import type { Behavior } from './capture/sdk-scenarios/replay-comparison.ts';
import { waitForCondition } from './oracle-run-stable-shapes.ts';

interface ReplayListenerUser {
  readonly uid: string;
  getIdToken(forceRefresh?: boolean): Promise<string>;
}

interface ReplayListenerAuthHandle {
  readonly currentUser: ReplayListenerUser | null;
}

export interface ReplayListenersAndMiddlewareAuthSdk {
  readonly inMemoryPersistence: unknown;
  initializeAuth(app: unknown, deps?: unknown): ReplayListenerAuthHandle;
  signInWithCustomToken(
    auth: ReplayListenerAuthHandle,
    customToken: string,
  ): Promise<{ user: ReplayListenerUser }>;
  signOut(auth: ReplayListenerAuthHandle): Promise<void>;
  updateProfile(
    user: ReplayListenerUser,
    profile: { displayName?: string | null; photoURL?: string | null },
  ): Promise<void>;
  onAuthStateChanged(
    auth: ReplayListenerAuthHandle,
    observer: (user: ReplayListenerUser | null) => void,
  ): () => void;
  onIdTokenChanged(
    auth: ReplayListenerAuthHandle,
    observer: (user: ReplayListenerUser | null) => void,
  ): () => void;
  beforeAuthStateChanged(
    auth: ReplayListenerAuthHandle,
    callback: (user: ReplayListenerUser | null) => void | Promise<void>,
    onAbort?: () => void,
  ): () => void;
}

interface ReplayListenersAdminAuth {
  createCustomToken(uid: string, developerClaims?: Record<string, unknown>): Promise<string>;
}

export interface AuthListenersAndMiddlewareReplayContext {
  readonly auth: ReplayListenerAuthHandle;
  readonly authSdk: ReplayListenersAndMiddlewareAuthSdk;
  readonly adminAuth: ReplayListenersAdminAuth;
  readonly FirebaseError: new (...args: never[]) => Error;
  createAuxiliaryApp(label: string): unknown;
  nextUid(label: string): string;
  cleanup(): Promise<void>;
}

export function createListenersAdminSession(
  sandbox: Sandbox,
  projectId: string,
  label: string,
): {
  readonly adminAuth: ReplayListenersAdminAuth;
  cleanup(): Promise<void>;
} {
  const adminApp = initializeAdminApp(
    { sandbox, projectId },
    `admin-listeners-${label}-${Math.random().toString(36).slice(2, 10)}`,
  );
  const adminAuth = getAdminAuth(adminApp) as unknown as ReplayListenersAdminAuth;
  return {
    adminAuth,
    cleanup: async () => {
      await deleteAdminApp(adminApp);
    },
  };
}

async function drainAuthNotifications(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 25);
  });
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
  }
}

export async function replayAuthOnAuthStateChangedSameUidDedupVsIdToken(
  ctx: AuthListenersAndMiddlewareReplayContext,
): Promise<Behavior> {
  try {
    const uidA = ctx.nextUid('dedup-a');
    const uidB = ctx.nextUid('dedup-b');
    const tokenA1 = await ctx.adminAuth.createCustomToken(uidA, { rev: 1 });
    const tokenA2 = await ctx.adminAuth.createCustomToken(uidA, { rev: 2 });
    const tokenB = await ctx.adminAuth.createCustomToken(uidB);

    const labelFor = (u: { uid: string } | null): string => {
      if (u === null) return 'null';
      if (u.uid === uidA) return 'uid-a';
      if (u.uid === uidB) return 'uid-b';
      return 'other';
    };

    const authStateEvents: string[] = [];
    const idTokenEvents: string[] = [];
    const unsubAuth = ctx.authSdk.onAuthStateChanged(ctx.auth, (u) => {
      authStateEvents.push(labelFor(u));
    });
    const unsubToken = ctx.authSdk.onIdTokenChanged(ctx.auth, (u) => {
      idTokenEvents.push(labelFor(u));
    });

    try {
      await waitForCondition(
        () => authStateEvents.length >= 1 && idTokenEvents.length >= 1,
        5000,
      );

      const credA1 = await ctx.authSdk.signInWithCustomToken(ctx.auth, tokenA1);
      await waitForCondition(
        () => authStateEvents.includes('uid-a') && idTokenEvents.includes('uid-a'),
        5000,
      );
      const jwtBeforeReSignIn = await credA1.user.getIdToken();

      const authCountBeforeProfile = authStateEvents.length;
      await ctx.authSdk.updateProfile(credA1.user, { displayName: 'Ada Lovelace' });
      await drainAuthNotifications();
      const authCountAfterProfile = authStateEvents.length;

      const authCountBeforeSameUid = authStateEvents.length;
      const idTokenCountBeforeSameUid = idTokenEvents.length;
      const credA2 = await ctx.authSdk.signInWithCustomToken(ctx.auth, tokenA2);
      await waitForCondition(() => idTokenEvents.length > idTokenCountBeforeSameUid, 5000);
      await drainAuthNotifications();
      const jwtAfterReSignIn = await credA2.user.getIdToken();
      const authFiredOnSameUidReSignIn = authStateEvents.length > authCountBeforeSameUid;
      const idTokenFiredOnSameUidReSignIn = idTokenEvents.length > idTokenCountBeforeSameUid;

      await ctx.authSdk.signInWithCustomToken(ctx.auth, tokenB);
      await waitForCondition(
        () => authStateEvents.includes('uid-b') && idTokenEvents.includes('uid-b'),
        5000,
      );

      return {
        authStateFiredOnProfileUpdate: authCountAfterProfile > authCountBeforeProfile,
        authStateFiredOnSameUidReSignIn: authFiredOnSameUidReSignIn,
        idTokenFiredOnSameUidReSignIn,
        jwtChangedAfterSameUidReSignIn: jwtAfterReSignIn !== jwtBeforeReSignIn,
        authStateSequence: authStateEvents,
        idTokenSequence: idTokenEvents,
      };
    } finally {
      unsubAuth();
      unsubToken();
    }
  } finally {
    await ctx.cleanup();
  }
}

export async function replayAuthOnAuthStateChangedDuplicateFnAndUnsubDuringEmit(
  ctx: AuthListenersAndMiddlewareReplayContext,
): Promise<Behavior> {
  try {
    const uidA = ctx.nextUid('dup-fn');
    const tokenA = await ctx.adminAuth.createCustomToken(uidA);

    const dupApp = ctx.createAuxiliaryApp('dup-observer-app');
    const dupAuth = ctx.authSdk.initializeAuth(dupApp, {
      persistence: ctx.authSdk.inMemoryPersistence,
    });

    const dupEvents: string[] = [];
    const sharedObserver = (u: { uid: string } | null): void => {
      if (u === null) {
        dupEvents.push('null');
      } else {
        dupEvents.push('user');
      }
    };

    const unsubDup1 = ctx.authSdk.onAuthStateChanged(dupAuth, sharedObserver);
    const unsubDup2 = ctx.authSdk.onAuthStateChanged(dupAuth, sharedObserver);
    let unsubDup3: (() => void) | null = null;

    let duplicateObserverResult: Record<string, unknown>;
    try {
      await waitForCondition(() => dupEvents.length >= 2, 5000);
      const initialDupEvents = [...dupEvents];

      const beforeSignInCount = dupEvents.length;
      await ctx.authSdk.signInWithCustomToken(dupAuth, tokenA);
      await waitForCondition(() => dupEvents.length >= beforeSignInCount + 2, 5000);
      await drainAuthNotifications();
      const signInFiresWhileBothActive = dupEvents.slice(beforeSignInCount);

      unsubDup1();
      const beforeSignOutCount = dupEvents.length;
      await ctx.authSdk.signOut(dupAuth);
      await waitForCondition(() => dupEvents.length >= beforeSignOutCount + 1, 5000);
      await drainAuthNotifications();
      const signOutFiresAfterOneUnsub = dupEvents.slice(beforeSignOutCount);

      unsubDup2();
      const beforeResubCount = dupEvents.length;
      unsubDup3 = ctx.authSdk.onAuthStateChanged(dupAuth, sharedObserver);
      await waitForCondition(() => dupEvents.length >= beforeResubCount + 1, 5000);
      const resubscribeInitialEvents = dupEvents.slice(beforeResubCount);

      duplicateObserverResult = {
        initialDupEvents,
        signInFiresWhileBothActive,
        signOutFiresAfterOneUnsub,
        resubscribeInitialEvents,
      };
    } finally {
      unsubDup1();
      unsubDup2();
      if (unsubDup3 !== null) {
        unsubDup3();
      }
    }

    const snapApp = ctx.createAuxiliaryApp('unsub-during-emit-app');
    const snapAuth = ctx.authSdk.initializeAuth(snapApp, {
      persistence: ctx.authSdk.inMemoryPersistence,
    });

    const initialReady: string[] = [];
    const transitionOrder: string[] = [];
    let unsubSubA: (() => void) | null = null;
    const unsubSubAHandle = ctx.authSdk.onAuthStateChanged(snapAuth, (u) => {
      if (u === null) {
        initialReady.push('A');
        return;
      }
      transitionOrder.push('sub-a');
      if (unsubSubA !== null) {
        unsubSubA();
      }
    });
    unsubSubA = unsubSubAHandle;

    const signOutOrder: string[] = [];
    const unsubSubB = ctx.authSdk.onAuthStateChanged(snapAuth, (u) => {
      if (u === null) {
        if (!initialReady.includes('B')) {
          initialReady.push('B');
          return;
        }
        signOutOrder.push('sub-b');
        return;
      }
      transitionOrder.push('sub-b');
    });
    const unsubSubC = ctx.authSdk.onAuthStateChanged(snapAuth, (u) => {
      if (u === null) {
        if (!initialReady.includes('C')) {
          initialReady.push('C');
          return;
        }
        signOutOrder.push('sub-c');
        return;
      }
      transitionOrder.push('sub-c');
    });

    try {
      await waitForCondition(() => initialReady.length === 3, 5000);
      await ctx.authSdk.signInWithCustomToken(snapAuth, tokenA);
      await waitForCondition(() => transitionOrder.includes('sub-c'), 5000);
      await drainAuthNotifications();

      await ctx.authSdk.signOut(snapAuth);
      await waitForCondition(() => signOutOrder.includes('sub-c'), 5000);
      await drainAuthNotifications();

      return {
        duplicateObserver: duplicateObserverResult,
        unsubDuringEmission: {
          signInTransitionVisitors: transitionOrder,
          subsequentSignOutVisitors: signOutOrder,
        },
      };
    } finally {
      unsubSubAHandle();
      unsubSubB();
      unsubSubC();
    }
  } finally {
    await ctx.cleanup();
  }
}

export async function replayAuthBeforeAuthStateChangedBlockSignInAndSignOut(
  ctx: AuthListenersAndMiddlewareReplayContext,
): Promise<Behavior> {
  try {
    const uid = ctx.nextUid('gate-dir');
    const token = await ctx.adminAuth.createCustomToken(uid);

    const authEvents: string[] = [];
    const idTokenEvents: string[] = [];
    const unsubAuth = ctx.authSdk.onAuthStateChanged(ctx.auth, (u) => {
      if (u === null) {
        authEvents.push('null');
      } else {
        authEvents.push('user');
      }
    });
    const unsubToken = ctx.authSdk.onIdTokenChanged(ctx.auth, (u) => {
      if (u === null) {
        idTokenEvents.push('null');
      } else {
        idTokenEvents.push('user');
      }
    });

    await waitForCondition(() => authEvents.length >= 1 && idTokenEvents.length >= 1, 5000);

    let blockTransitions = true;
    const gateDirections: string[] = [];
    const unsubGate = ctx.authSdk.beforeAuthStateChanged(ctx.auth, async (nextUser) => {
      if (nextUser === null) {
        gateDirections.push('null');
      } else {
        gateDirections.push('user');
      }
      if (blockTransitions) {
        throw new Error('transition-blocked-by-policy');
      }
    });

    try {
      const authCountBeforeBlockedSignIn = authEvents.length;
      const tokenCountBeforeBlockedSignIn = idTokenEvents.length;
      const blockedSignIn = await observeAsyncAuthAttempt(
        () => ctx.authSdk.signInWithCustomToken(ctx.auth, token),
        ctx.FirebaseError,
      );
      await drainAuthNotifications();
      const afterBlockedSignIn = {
        attempt: blockedSignIn,
        currentUserRemainsNull: ctx.auth.currentUser === null,
        authListenerSilent: authEvents.length === authCountBeforeBlockedSignIn,
        idTokenListenerSilent: idTokenEvents.length === tokenCountBeforeBlockedSignIn,
      };

      blockTransitions = false;
      await ctx.authSdk.signInWithCustomToken(ctx.auth, token);
      await waitForCondition(() => authEvents.includes('user'), 5000);
      const signedInAfterUnblock = ctx.auth.currentUser?.uid === uid;

      blockTransitions = true;
      const authCountBeforeBlockedSignOut = authEvents.length;
      const tokenCountBeforeBlockedSignOut = idTokenEvents.length;
      const blockedSignOut = await observeAsyncAuthAttempt(
        () => ctx.authSdk.signOut(ctx.auth),
        ctx.FirebaseError,
      );
      await drainAuthNotifications();
      const afterBlockedSignOut = {
        attempt: blockedSignOut,
        previousUserRemainsSignedIn: ctx.auth.currentUser?.uid === uid,
        authListenerSilent: authEvents.length === authCountBeforeBlockedSignOut,
        idTokenListenerSilent: idTokenEvents.length === tokenCountBeforeBlockedSignOut,
      };

      unsubGate();
      await ctx.authSdk.signOut(ctx.auth);
      await waitForCondition(() => authEvents[authEvents.length - 1] === 'null', 5000);

      return {
        gateDirections,
        afterBlockedSignIn,
        signedInAfterUnblock,
        afterBlockedSignOut,
        signedOutAfterGateRemoved: ctx.auth.currentUser === null,
      };
    } finally {
      unsubGate();
      unsubAuth();
      unsubToken();
    }
  } finally {
    await ctx.cleanup();
  }
}

export async function replayAuthBeforeAuthStateChangedOnAbortReverseAndSwallow(
  ctx: AuthListenersAndMiddlewareReplayContext,
): Promise<Behavior> {
  try {
    const uid = ctx.nextUid('onabort');
    const token = await ctx.adminAuth.createCustomToken(uid);

    const gateApp = ctx.createAuxiliaryApp('onabort-stack-app');
    const gateAuth = ctx.authSdk.initializeAuth(gateApp, {
      persistence: ctx.authSdk.inMemoryPersistence,
    });

    const runOrder: string[] = [];
    const abortOrder: string[] = [];

    const unsub1 = ctx.authSdk.beforeAuthStateChanged(
      gateAuth,
      () => {
        runOrder.push('gate-1-ok');
      },
      () => {
        abortOrder.push('abort-1');
      },
    );
    const unsub2 = ctx.authSdk.beforeAuthStateChanged(
      gateAuth,
      async () => {
        runOrder.push('gate-2-ok');
      },
      () => {
        abortOrder.push('abort-2-throws');
        throw new Error('onabort-2-failure');
      },
    );
    const unsub3 = ctx.authSdk.beforeAuthStateChanged(
      gateAuth,
      () => {
        runOrder.push('gate-3-throws');
        throw new Error('gate-3-rejected');
      },
      () => {
        abortOrder.push('abort-3-should-not-run');
      },
    );
    const unsub4 = ctx.authSdk.beforeAuthStateChanged(
      gateAuth,
      () => {
        runOrder.push('gate-4-should-not-run');
      },
      () => {
        abortOrder.push('abort-4-should-not-run');
      },
    );

    try {
      const blockedAttempt = await observeAsyncAuthAttempt(
        () => ctx.authSdk.signInWithCustomToken(gateAuth, token),
        ctx.FirebaseError,
      );

      return {
        blockedAttempt,
        currentUserRemainsNull: gateAuth.currentUser === null,
        runOrder,
        abortOrder,
      };
    } finally {
      unsub1();
      unsub2();
      unsub3();
      unsub4();
    }
  } finally {
    await ctx.cleanup();
  }
}
