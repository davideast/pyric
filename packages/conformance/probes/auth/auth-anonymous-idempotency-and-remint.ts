import type { Probe } from '../../rigs/types.ts';
import {
  decodeJwtParts,
  withClientAuthProbeSession,
} from '../../src/auth-user-probe-session.ts';
import { retryAuthTooManyRequests } from '../../src/oracle-run-auth-session.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'admin-auth'],
  matrixRow: 'auth#8',
  rowIds: ['auth#8', 'auth#9'],
  description:
    'signInAnonymously sets currentUser and ID token uid claims, returns the existing anonymous user without minting a new uid when already signed in anonymously, and mints a fresh uid after signOut.',
  async observe() {
    return withClientAuthProbeSession(async ({ auth, authSdk, trackUid }) => {
      const cred1 = await retryAuthTooManyRequests('auth-anon-first', () =>
        authSdk.signInAnonymously(auth),
      );
      trackUid(cred1.user.uid);
      const currentUserAfterFirst = auth.currentUser;
      const token1 = await cred1.user.getIdToken();
      const jwt1 = decodeJwtParts(token1);
      const firebaseClaim = jwt1.payload.firebase as
        | { sign_in_provider?: unknown }
        | undefined;
      let tokenSignInProvider: string | null = null;
      if (typeof firebaseClaim?.sign_in_provider === 'string') {
        tokenSignInProvider = firebaseClaim.sign_in_provider;
      }

      const cred2 = await retryAuthTooManyRequests('auth-anon-repeat', () =>
        authSdk.signInAnonymously(auth),
      );
      trackUid(cred2.user.uid);
      const currentUserAfterRepeat = auth.currentUser;

      await authSdk.signOut(auth);
      const currentUserNullAfterSignOut = auth.currentUser === null;

      const cred3 = await retryAuthTooManyRequests('auth-anon-remint', () =>
        authSdk.signInAnonymously(auth),
      );
      trackUid(cred3.user.uid);

      return {
        initialSignIn: {
          setsCurrentUser: currentUserAfterFirst === cred1.user,
          isAnonymous: cred1.user.isAnonymous,
          email: cred1.user.email,
          displayName: cred1.user.displayName,
          tokenSubMatchesUid: jwt1.payload.sub === cred1.user.uid,
          tokenUserIdMatchesUid: jwt1.payload.user_id === cred1.user.uid,
          tokenSignInProvider,
        },
        repeatWhileSignedIn: {
          sameUid: cred2.user.uid === cred1.user.uid,
          sameUserRef: cred2.user === cred1.user,
          currentUserUnchanged: currentUserAfterRepeat === cred1.user,
          operationType: cred2.operationType,
          providerId: cred2.providerId,
        },
        afterSignOut: {
          currentUserNullAfterSignOut,
          mintedFreshUid: cred3.user.uid !== cred1.user.uid && cred3.user.uid.length > 0,
          isAnonymous: cred3.user.isAnonymous,
          setsCurrentUser: auth.currentUser === cred3.user,
        },
      };
    });
  },
};
