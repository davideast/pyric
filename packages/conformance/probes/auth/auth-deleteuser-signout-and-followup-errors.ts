import { FirebaseError } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';
import {
  observeAsyncAuthAttempt,
  withClientAuthProbeSession,
} from '../../src/auth-user-probe-session.ts';
import { waitForCondition } from '../../src/oracle-run-stable-shapes.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'admin-auth'],
  matrixRow: 'auth#83',
  rowIds: ['auth#83'],
  description:
    'deleteUser(user) removes the account, clears auth.currentUser with an onAuthStateChanged(null) transition, and causes subsequent reload(user) and signInWithEmailAndPassword calls to reject.',
  async observe() {
    return withClientAuthProbeSession(
      async ({ auth, authSdk, adminAuth, createProbeUser, nextEmail, nextUid }) => {
        const uid = nextUid('deluser');
        const email = nextEmail('deluser');
        const password = 'ProbePassword!123';
        await createProbeUser({ uid, email, password });

        const cred = await authSdk.signInWithEmailAndPassword(auth, email, password);
        const heldUser = cred.user;

        const observedStates: Array<'user' | 'null'> = [];
        const unsub = authSdk.onAuthStateChanged(auth, (current) => {
          if (current === null) {
            observedStates.push('null');
          } else {
            observedStates.push('user');
          }
        });
        await waitForCondition(() => observedStates.length >= 1, 5000);
        const countBeforeDelete = observedStates.length;

        await authSdk.deleteUser(heldUser);
        await waitForCondition(
          () => observedStates.slice(countBeforeDelete).includes('null'),
          5000,
        );
        unsub();

        let adminLookupCode: string | null = null;
        try {
          await adminAuth.getUser(uid);
        } catch (err) {
          const rawCode = (err as { code?: unknown }).code;
          if (typeof rawCode === 'string') {
            adminLookupCode = rawCode;
          }
        }

        const reloadAfterDelete = await observeAsyncAuthAttempt(
          () => authSdk.reload(heldUser),
          FirebaseError,
        );
        const signInAfterDelete = await observeAsyncAuthAttempt(
          () => authSdk.signInWithEmailAndPassword(auth, email, password),
          FirebaseError,
        );

        return {
          currentUserNullAfterDelete: auth.currentUser === null,
          firedNullAuthStateOnDelete: observedStates.slice(countBeforeDelete).includes('null'),
          adminLookupCodeAfterDelete: adminLookupCode,
          reloadAfterDelete,
          signInAfterDelete,
        };
      },
    );
  },
};
