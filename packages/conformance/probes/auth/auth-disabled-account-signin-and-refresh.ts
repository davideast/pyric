import { FirebaseError } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';
import {
  observeAsyncAuthAttempt,
  withClientAuthProbeSession,
} from '../../src/auth-user-probe-session.ts';

const PROBE_PASSWORD = 'ProbePassword!123';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'admin-auth'],
  matrixRow: 'auth#69',
  rowIds: ['auth#69'],
  description:
    'Disabling a user leaves an existing client session signed in until forced token refresh rejects with auth/user-disabled and signs out, and rejects subsequent password and custom-token sign-in attempts.',
  async observe() {
    return withClientAuthProbeSession(
      async ({ adminAuth, auth, authSdk, createProbeUser, nextEmail, nextUid }) => {
        const uid = nextUid('disabled');
        const email = nextEmail('disabled');
        await createProbeUser({ uid, email, password: PROBE_PASSWORD });

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
      },
    );
  },
};
