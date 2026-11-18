import { FirebaseError } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';
import {
  observeAsyncAuthAttempt,
  withClientAuthProbeSession,
} from '../../src/auth-user-probe-session.ts';
import { waitForCondition } from '../../src/oracle-run-stable-shapes.ts';

async function drainAuthMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'admin-auth'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'beforeAuthStateChanged blocks both sign-in and signOut transitions with auth/login-blocked when a registered callback throws or rejects, leaving currentUser unchanged and suppressing state/token listener notifications.',
  async observe() {
    return withClientAuthProbeSession(
      async ({ adminAuth, auth, authSdk, nextUid, trackUid }) => {
        const uid = trackUid(nextUid('gate-dir'));
        const token = await adminAuth.createCustomToken(uid);

        const authEvents: string[] = [];
        const idTokenEvents: string[] = [];
        const unsubAuth = authSdk.onAuthStateChanged(auth, (u) => {
          if (u === null) {
            authEvents.push('null');
          } else {
            authEvents.push('user');
          }
        });
        const unsubToken = authSdk.onIdTokenChanged(auth, (u) => {
          if (u === null) {
            idTokenEvents.push('null');
          } else {
            idTokenEvents.push('user');
          }
        });

        await waitForCondition(
          () => authEvents.length >= 1 && idTokenEvents.length >= 1,
          5000,
        );

        let blockTransitions = true;
        const gateDirections: string[] = [];
        const unsubGate = authSdk.beforeAuthStateChanged(auth, async (nextUser) => {
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
            () => authSdk.signInWithCustomToken(auth, token),
            FirebaseError,
          );
          await drainAuthMicrotasks();
          const afterBlockedSignIn = {
            attempt: blockedSignIn,
            currentUserRemainsNull: auth.currentUser === null,
            authListenerSilent: authEvents.length === authCountBeforeBlockedSignIn,
            idTokenListenerSilent: idTokenEvents.length === tokenCountBeforeBlockedSignIn,
          };

          blockTransitions = false;
          await authSdk.signInWithCustomToken(auth, token);
          await waitForCondition(() => authEvents.includes('user'), 5000);
          const signedInAfterUnblock = auth.currentUser?.uid === uid;

          blockTransitions = true;
          const authCountBeforeBlockedSignOut = authEvents.length;
          const tokenCountBeforeBlockedSignOut = idTokenEvents.length;
          const blockedSignOut = await observeAsyncAuthAttempt(
            () => authSdk.signOut(auth),
            FirebaseError,
          );
          await drainAuthMicrotasks();
          const afterBlockedSignOut = {
            attempt: blockedSignOut,
            previousUserRemainsSignedIn: auth.currentUser?.uid === uid,
            authListenerSilent: authEvents.length === authCountBeforeBlockedSignOut,
            idTokenListenerSilent:
              idTokenEvents.length === tokenCountBeforeBlockedSignOut,
          };

          unsubGate();
          await authSdk.signOut(auth);
          await waitForCondition(
            () => authEvents[authEvents.length - 1] === 'null',
            5000,
          );

          return {
            gateDirections,
            afterBlockedSignIn,
            signedInAfterUnblock,
            afterBlockedSignOut,
            signedOutAfterGateRemoved: auth.currentUser === null,
          };
        } finally {
          unsubGate();
          unsubAuth();
          unsubToken();
        }
      },
    );
  },
};
