import type { Probe } from '../../rigs/types.ts';
import { withClientAuthProbeSession } from '../../src/auth-user-probe-session.ts';
import { waitForCondition } from '../../src/oracle-run-stable-shapes.ts';

async function drainAuthMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'admin-auth'],
  matrixRow: 'auth#33a',
  rowIds: ['auth#33a', 'auth#34'],
  description:
    'onAuthStateChanged maintains independent per-registration entries for duplicate observer references (firing again on resubscribe) and does not skip sibling subscribers when one unsubscribes during emission.',
  async observe() {
    return withClientAuthProbeSession(
      async ({
        adminAuth,
        authSdk,
        createAuxiliaryClientApp,
        nextUid,
        trackUid,
      }) => {
        const uidA = trackUid(nextUid('dup-fn'));
        const tokenA = await adminAuth.createCustomToken(uidA);

        const dupApp = createAuxiliaryClientApp('dup-observer-app');
        const dupAuth = authSdk.initializeAuth(dupApp, {
          persistence: authSdk.inMemoryPersistence,
        });

        const dupEvents: string[] = [];
        const sharedObserver = (u: { uid: string } | null): void => {
          if (u === null) {
            dupEvents.push('null');
          } else {
            dupEvents.push('user');
          }
        };

        const unsubDup1 = authSdk.onAuthStateChanged(dupAuth, sharedObserver);
        const unsubDup2 = authSdk.onAuthStateChanged(dupAuth, sharedObserver);
        let unsubDup3: (() => void) | null = null;

        let duplicateObserverResult: Record<string, unknown>;
        try {
          await waitForCondition(() => dupEvents.length >= 2, 5000);
          const initialDupEvents = [...dupEvents];

          const beforeSignInCount = dupEvents.length;
          await authSdk.signInWithCustomToken(dupAuth, tokenA);
          await waitForCondition(() => dupEvents.length >= beforeSignInCount + 2, 5000);
          await drainAuthMicrotasks();
          const signInFiresWhileBothActive = dupEvents.slice(beforeSignInCount);

          unsubDup1();
          const beforeSignOutCount = dupEvents.length;
          await authSdk.signOut(dupAuth);
          await waitForCondition(() => dupEvents.length >= beforeSignOutCount + 1, 5000);
          await drainAuthMicrotasks();
          const signOutFiresAfterOneUnsub = dupEvents.slice(beforeSignOutCount);

          unsubDup2();
          const beforeResubCount = dupEvents.length;
          unsubDup3 = authSdk.onAuthStateChanged(dupAuth, sharedObserver);
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

        const snapApp = createAuxiliaryClientApp('unsub-during-emit-app');
        const snapAuth = authSdk.initializeAuth(snapApp, {
          persistence: authSdk.inMemoryPersistence,
        });

        const initialReady: string[] = [];
        const transitionOrder: string[] = [];
        let unsubSubA: (() => void) | null = null;
        const unsubSubAHandle = authSdk.onAuthStateChanged(snapAuth, (u) => {
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
        const unsubSubB = authSdk.onAuthStateChanged(snapAuth, (u) => {
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
        const unsubSubC = authSdk.onAuthStateChanged(snapAuth, (u) => {
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
          await authSdk.signInWithCustomToken(snapAuth, tokenA);
          await waitForCondition(() => transitionOrder.includes('sub-c'), 5000);
          await drainAuthMicrotasks();

          await authSdk.signOut(snapAuth);
          await waitForCondition(() => signOutOrder.includes('sub-c'), 5000);
          await drainAuthMicrotasks();

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
      },
    );
  },
};
