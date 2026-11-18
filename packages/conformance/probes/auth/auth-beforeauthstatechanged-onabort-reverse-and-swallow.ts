import { FirebaseError } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';
import {
  observeAsyncAuthAttempt,
  withClientAuthProbeSession,
} from '../../src/auth-user-probe-session.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'admin-auth'],
  matrixRow: 'auth#76a',
  rowIds: ['auth#76a'],
  description:
    'beforeAuthStateChanged invokes onAbort callbacks in reverse registration order only for gates that already succeeded in the current pass, swallowing errors thrown inside onAbort without masking auth/login-blocked.',
  async observe() {
    return withClientAuthProbeSession(
      async ({
        adminAuth,
        authSdk,
        createAuxiliaryClientApp,
        nextUid,
        trackUid,
      }) => {
        const uid = trackUid(nextUid('onabort'));
        const token = await adminAuth.createCustomToken(uid);

        const gateApp = createAuxiliaryClientApp('onabort-stack-app');
        const gateAuth = authSdk.initializeAuth(gateApp, {
          persistence: authSdk.inMemoryPersistence,
        });

        const runOrder: string[] = [];
        const abortOrder: string[] = [];

        const unsub1 = authSdk.beforeAuthStateChanged(
          gateAuth,
          () => {
            runOrder.push('gate-1-ok');
          },
          () => {
            abortOrder.push('abort-1');
          },
        );
        const unsub2 = authSdk.beforeAuthStateChanged(
          gateAuth,
          async () => {
            runOrder.push('gate-2-ok');
          },
          () => {
            abortOrder.push('abort-2-throws');
            throw new Error('onabort-2-failure');
          },
        );
        const unsub3 = authSdk.beforeAuthStateChanged(
          gateAuth,
          () => {
            runOrder.push('gate-3-throws');
            throw new Error('gate-3-rejected');
          },
          () => {
            abortOrder.push('abort-3-should-not-run');
          },
        );
        const unsub4 = authSdk.beforeAuthStateChanged(
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
            () => authSdk.signInWithCustomToken(gateAuth, token),
            FirebaseError,
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
      },
    );
  },
};
