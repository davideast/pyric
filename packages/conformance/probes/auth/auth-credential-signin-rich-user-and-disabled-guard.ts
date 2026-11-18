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
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'signInWithCredential preserves rich User profile fields and reference identity with auth.currentUser, records the credential providerId, and rejects disabled accounts with auth/user-disabled before mutating auth state.',
  async observe() {
    return withClientAuthProbeSession(
      async ({ auth, authSdk, createProbeUser, nextEmail, nextUid }) => {
        const password = 'ProbePassword!123';
        const uidActive = nextUid('cred-rich');
        const emailActive = nextEmail('cred-rich');
        await createProbeUser({
          uid: uidActive,
          email: emailActive,
          password,
          displayName: 'Rich Profile User',
          photoURL: 'https://example.com/rich-avatar.png',
          emailVerified: true,
        });

        const credActive = await authSdk.signInWithCredential(
          auth,
          authSdk.EmailAuthProvider.credential(emailActive, password),
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
        await createProbeUser({
          uid: uidDisabled,
          email: emailDisabled,
          password,
          disabled: true,
        });

        const stateEmissions: Array<'user' | 'null'> = [];
        const unsubState = authSdk.onAuthStateChanged(auth, (user) => {
          if (user === null) {
            stateEmissions.push('null');
          } else {
            stateEmissions.push('user');
          }
        });
        let disabledWhileSignedInAttempt;
        let currentUserPreservedRef = false;
        let currentUserPreservedUid = false;
        let authStateTransitionsDuringFailure = 0;
        try {
          await waitForCondition(() => stateEmissions.length >= 1, 5000);
          const baselineCount = stateEmissions.length;
          disabledWhileSignedInAttempt = await observeAsyncAuthAttempt(
            () =>
              authSdk.signInWithCredential(
                auth,
                authSdk.EmailAuthProvider.credential(emailDisabled, password),
              ),
            FirebaseError,
          );
          currentUserPreservedRef = auth.currentUser === credActive.user;
          currentUserPreservedUid = auth.currentUser?.uid === uidActive;
          authStateTransitionsDuringFailure = stateEmissions.length - baselineCount;
        } finally {
          unsubState();
        }

        await authSdk.signOut(auth);
        const disabledWhenSignedOutAttempt = await observeAsyncAuthAttempt(
          () =>
            authSdk.signInWithCredential(
              auth,
              authSdk.EmailAuthProvider.credential(emailDisabled, password),
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
      },
    );
  },
};
