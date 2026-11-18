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
  matrixRow: 'auth#87',
  rowIds: ['auth#87'],
  description:
    'updateCurrentUser(auth, user) sets auth.currentUser (and fires onAuthStateChanged), passing null clears auth.currentUser to sign out, and mismatched tenantId rejects with auth/tenant-id-mismatch.',
  async observe() {
    return withClientAuthProbeSession(
      async ({
        auth,
        authSdk,
        createAuxiliaryClientApp,
        createProbeUser,
        nextEmail,
        nextUid,
      }) => {
        const uid = nextUid('upcur');
        const email = nextEmail('upcur');
        const password = 'ProbePassword!123';
        await createProbeUser({ uid, email, password });

        const cred = await authSdk.signInWithEmailAndPassword(auth, email, password);
        const sourceUser = cred.user;

        const secondaryApp = createAuxiliaryClientApp('secondary-current');
        const secondaryAuth = authSdk.initializeAuth(secondaryApp, {
          persistence: authSdk.inMemoryPersistence,
        });

        const transitions: Array<'null' | 'matched-uid' | 'other-uid'> = [];
        const unsub = authSdk.onAuthStateChanged(secondaryAuth, (u) => {
          if (u === null) {
            transitions.push('null');
          } else if (u.uid === uid) {
            transitions.push('matched-uid');
          } else {
            transitions.push('other-uid');
          }
        });
        await waitForCondition(() => transitions.length >= 1, 5000);
        const beforeSetLen = transitions.length;

        await authSdk.updateCurrentUser(secondaryAuth, sourceUser);
        await waitForCondition(
          () => transitions.slice(beforeSetLen).includes('matched-uid'),
          5000,
        );
        const afterSetUser = {
          currentUserNonNull: secondaryAuth.currentUser !== null,
          uidMatchesSource: secondaryAuth.currentUser?.uid === uid,
          clonesAcrossAuthInstances: secondaryAuth.currentUser !== sourceUser,
          firedMatchedUidTransition: transitions.slice(beforeSetLen).includes('matched-uid'),
        };

        const beforeClearLen = transitions.length;
        await authSdk.updateCurrentUser(secondaryAuth, null);
        await waitForCondition(
          () => transitions.slice(beforeClearLen).includes('null'),
          5000,
        );
        unsub();

        const afterClearNull = {
          secondaryCurrentUserIsNull: secondaryAuth.currentUser === null,
          primaryCurrentUserIntact: auth.currentUser?.uid === uid,
          firedNullTransition: transitions.slice(beforeClearLen).includes('null'),
        };

        const tenantApp = createAuxiliaryClientApp('tenant-mismatch');
        const tenantAuth = authSdk.initializeAuth(tenantApp, {
          persistence: authSdk.inMemoryPersistence,
        });
        tenantAuth.tenantId = 'other-tenant';
        const tenantMismatchAttempt = await observeAsyncAuthAttempt(
          () => authSdk.updateCurrentUser(tenantAuth, sourceUser),
          FirebaseError,
        );

        return {
          afterSetUser,
          afterClearNull,
          tenantMismatchAttempt,
          tenantCurrentUserRemainsNull: tenantAuth.currentUser === null,
        };
      },
    );
  },
};
