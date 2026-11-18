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
  matrixRow: 'auth#86',
  rowIds: ['auth#86'],
  description:
    'reload(user) updates held User fields in place after out-of-band mutations, and rejects while signing out currentUser when the account is disabled or deleted out-of-band.',
  async observe() {
    return withClientAuthProbeSession(
      async ({ auth, authSdk, adminAuth, createProbeUser, nextEmail, nextUid }) => {
        const uidA = nextUid('reload-ok');
        const emailA = nextEmail('reload-ok');
        const password = 'ProbePassword!123';
        await createProbeUser({ uid: uidA, email: emailA, password });

        const credA = await authSdk.signInWithEmailAndPassword(auth, emailA, password);
        const heldA = credA.user;
        const beforeReload = {
          displayName: heldA.displayName,
          photoURL: heldA.photoURL,
          emailVerified: heldA.emailVerified,
        };

        await adminAuth.updateUser(uidA, {
          displayName: 'Reloaded Name',
          photoURL: 'https://example.com/reloaded.png',
          emailVerified: true,
        });
        await authSdk.reload(heldA);
        const afterReload = {
          sameCurrentUserRef: auth.currentUser === heldA,
          displayName: heldA.displayName,
          photoURL: heldA.photoURL,
          emailVerified: heldA.emailVerified,
        };
        await authSdk.signOut(auth);

        const uidDisabled = nextUid('reload-disabled');
        const emailDisabled = nextEmail('reload-disabled');
        await createProbeUser({ uid: uidDisabled, email: emailDisabled, password });
        const credDisabled = await authSdk.signInWithEmailAndPassword(
          auth,
          emailDisabled,
          password,
        );
        const heldDisabled = credDisabled.user;
        const disabledStates: Array<'user' | 'null'> = [];
        const unsubDisabled = authSdk.onAuthStateChanged(auth, (current) => {
          if (current === null) {
            disabledStates.push('null');
          } else {
            disabledStates.push('user');
          }
        });
        await waitForCondition(() => disabledStates.length >= 1, 5000);
        const countBeforeDisabledReload = disabledStates.length;
        await adminAuth.updateUser(uidDisabled, { disabled: true });
        const disabledReloadAttempt = await observeAsyncAuthAttempt(
          () => authSdk.reload(heldDisabled),
          FirebaseError,
        );
        await waitForCondition(
          () =>
            auth.currentUser === null &&
            disabledStates.slice(countBeforeDisabledReload).includes('null'),
          1500,
        );
        unsubDisabled();
        const disabledCurrentUserNull = auth.currentUser === null;
        const disabledSawNull = disabledStates.slice(countBeforeDisabledReload).includes('null');
        if (auth.currentUser !== null) {
          await authSdk.signOut(auth);
        }

        const uidDeleted = nextUid('reload-deleted');
        const emailDeleted = nextEmail('reload-deleted');
        await createProbeUser({ uid: uidDeleted, email: emailDeleted, password });
        const credDeleted = await authSdk.signInWithEmailAndPassword(
          auth,
          emailDeleted,
          password,
        );
        const heldDeleted = credDeleted.user;
        const deletedStates: Array<'user' | 'null'> = [];
        const unsubDeleted = authSdk.onAuthStateChanged(auth, (current) => {
          if (current === null) {
            deletedStates.push('null');
          } else {
            deletedStates.push('user');
          }
        });
        await waitForCondition(() => deletedStates.length >= 1, 5000);
        const countBeforeDeletedReload = deletedStates.length;
        await adminAuth.deleteUser(uidDeleted);
        const deletedReloadAttempt = await observeAsyncAuthAttempt(
          () => authSdk.reload(heldDeleted),
          FirebaseError,
        );
        await waitForCondition(
          () =>
            auth.currentUser === null &&
            deletedStates.slice(countBeforeDeletedReload).includes('null'),
          1500,
        );
        unsubDeleted();
        const deletedCurrentUserNull = auth.currentUser === null;
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
      },
    );
  },
};
