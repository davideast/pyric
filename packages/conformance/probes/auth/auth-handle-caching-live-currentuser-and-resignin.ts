import type { Probe } from '../../rigs/types.ts';
import { withClientAuthProbeSession } from '../../src/auth-user-probe-session.ts';

const PROBE_PASSWORD = 'ProbePassword!123';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'admin-auth'],
  matrixRow: 'auth#1',
  rowIds: ['auth#1', 'auth#5', 'auth#16', 'auth#49e'],
  description:
    'getAuth(app) caches one Auth handle per FirebaseApp, auth.currentUser reads live session state across sign-in and both auth.signOut() method and free signOut(auth) calls, and signInWithEmailAndPassword returns the same uid on re-sign-in.',
  async observe() {
    return withClientAuthProbeSession(
      async ({ auth, authSdk, createAuxiliaryClientApp, createProbeUser, nextEmail, nextUid }) => {
        const sameAppReturnsSameHandle = authSdk.getAuth(auth.app) === auth;
        const auxApp = createAuxiliaryClientApp('handle-cache');
        const auxAuth1 = authSdk.getAuth(auxApp);
        const auxAuth2 = authSdk.getAuth(auxApp);
        const distinctAppReturnsDistinctHandle = auxAuth1 !== auth;
        const auxSameAppReturnsSameHandle = auxAuth1 === auxAuth2;

        const uid = nextUid('resignin');
        const email = nextEmail('resignin');
        await createProbeUser({ uid, email, password: PROBE_PASSWORD });

        const heldAuth = auth;
        const initialCurrentUserNull = heldAuth.currentUser === null;

        const cred1 = await authSdk.signInWithEmailAndPassword(heldAuth, email, PROBE_PASSWORD);
        const firstSignInMatchesSeededUid = cred1.user.uid === uid;
        const liveGetterReadsSignedInUid = heldAuth.currentUser?.uid === uid;

        const methodSignOutResult = await heldAuth.signOut();
        const methodSignOutResolvesUndefined = methodSignOutResult === undefined;
        const liveGetterNullAfterMethodSignOut = heldAuth.currentUser === null;

        const cred2 = await authSdk.signInWithEmailAndPassword(heldAuth, email, PROBE_PASSWORD);
        const reSignInReturnsSameUid = cred2.user.uid === uid;
        const liveGetterReadsReSignedInUid = heldAuth.currentUser?.uid === uid;

        const freeSignOutResult = await authSdk.signOut(heldAuth);
        const freeSignOutResolvesUndefined = freeSignOutResult === undefined;
        const liveGetterNullAfterFreeSignOut = heldAuth.currentUser === null;

        return {
          handleCaching: {
            sameAppReturnsSameHandle,
            distinctAppReturnsDistinctHandle,
            auxSameAppReturnsSameHandle,
          },
          liveCurrentUserAndReSignIn: {
            initialCurrentUserNull,
            firstSignInMatchesSeededUid,
            liveGetterReadsSignedInUid,
            methodSignOutResolvesUndefined,
            liveGetterNullAfterMethodSignOut,
            reSignInReturnsSameUid,
            liveGetterReadsReSignedInUid,
            freeSignOutResolvesUndefined,
            liveGetterNullAfterFreeSignOut,
          },
        };
      },
    );
  },
};
