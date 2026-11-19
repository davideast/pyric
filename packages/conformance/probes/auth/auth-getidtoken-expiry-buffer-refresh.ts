import type { Probe } from '../../rigs/types.ts';
import {
  decodeJwtParts,
  withClientAuthProbeSession,
} from '../../src/auth-user-probe-session.ts';
import { waitForCondition } from '../../src/oracle-run-stable-shapes.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'admin-auth'],
  matrixRow: 'auth#55a',
  rowIds: ['auth#55a'],
  description:
    'getIdToken() mints a 3600s JWT, returns the cached token before expirationTime minus 30s, and refreshes non-forced inside the 30s expiry buffer while firing onIdTokenChanged without firing onAuthStateChanged.',
  async observe() {
    return withClientAuthProbeSession(
      async ({ auth, authSdk, adminAuth, createProbeUser, nextEmail, nextUid }) => {
        const uid = nextUid('token-expiry');
        const email = nextEmail('token-expiry');
        const password = 'ProbePassword!123';
        await createProbeUser({ uid, email, password });

        const cred = await authSdk.signInWithEmailAndPassword(auth, email, password);
        const token0 = await cred.user.getIdToken();
        const jwt0 = decodeJwtParts(token0);
        const initialExpMinusIatSeconds =
          Number(jwt0.payload.exp) - Number(jwt0.payload.iat);

        const serialized = cred.user.toJSON() as {
          stsTokenManager?: { expirationTime?: unknown };
        };
        let expirationMs = Number(jwt0.payload.exp) * 1000;
        if (typeof serialized.stsTokenManager?.expirationTime === 'number') {
          expirationMs = serialized.stsTokenManager.expirationTime;
        }

        let idTokenFires = 0;
        let authStateFires = 0;
        const unsubIdToken = authSdk.onIdTokenChanged(auth, () => {
          idTokenFires += 1;
        });
        const unsubAuthState = authSdk.onAuthStateChanged(auth, () => {
          authStateFires += 1;
        });

        const realDateNow = Date.now;
        try {
          await waitForCondition(
            () => idTokenFires >= 1 && authStateFires >= 1,
            5000,
          );
          if (idTokenFires < 1 || authStateFires < 1) {
            throw new Error(
              'Initial onIdTokenChanged/onAuthStateChanged emissions did not arrive within 5000ms.',
            );
          }
          await adminAuth.setCustomUserClaims(uid, {
            refreshProbeStage: 'post-expiry',
          });

          const idTokenBaselineBefore = idTokenFires;
          const authStateBaselineBefore = authStateFires;
          let tokenBeforeBuffer: string;
          try {
            Date.now = () => expirationMs - 45_000;
            tokenBeforeBuffer = await cred.user.getIdToken();
          } finally {
            Date.now = realDateNow;
          }
          await Promise.resolve();
          const jwtBeforeBuffer = decodeJwtParts(tokenBeforeBuffer);
          const beforeRefreshBuffer = {
            returnedCachedToken: tokenBeforeBuffer === token0,
            carriesUpdatedClaim:
              jwtBeforeBuffer.payload.refreshProbeStage === 'post-expiry',
            idTokenChangedFires: idTokenFires - idTokenBaselineBefore,
            authStateChangedFires: authStateFires - authStateBaselineBefore,
          };

          const idTokenBaselineInside = idTokenFires;
          const authStateBaselineInside = authStateFires;
          let tokenInsideBuffer: string;
          try {
            Date.now = () => expirationMs - 15_000;
            tokenInsideBuffer = await cred.user.getIdToken();
          } finally {
            Date.now = realDateNow;
          }
          await waitForCondition(
            () => idTokenFires > idTokenBaselineInside,
            5000,
          );
          if (idTokenFires <= idTokenBaselineInside) {
            throw new Error(
              'onIdTokenChanged did not emit after non-forced refresh inside the 30s expiry buffer.',
            );
          }
          await Promise.resolve();

          const jwtInsideBuffer = decodeJwtParts(tokenInsideBuffer);
          const tokenSubsequentCached = await cred.user.getIdToken();
          const insideRefreshBuffer = {
            mintedFreshToken: tokenInsideBuffer !== token0,
            carriesUpdatedClaim:
              jwtInsideBuffer.payload.refreshProbeStage === 'post-expiry',
            refreshedExpMinusIatSeconds:
              Number(jwtInsideBuffer.payload.exp) -
              Number(jwtInsideBuffer.payload.iat),
            idTokenChangedFires: idTokenFires - idTokenBaselineInside,
            authStateChangedFires: authStateFires - authStateBaselineInside,
            subsequentReadReturnsNewCachedToken:
              tokenSubsequentCached === tokenInsideBuffer,
          };

          return {
            initialExpMinusIatSeconds,
            beforeRefreshBuffer,
            insideRefreshBuffer,
          };
        } finally {
          Date.now = realDateNow;
          unsubIdToken();
          unsubAuthState();
        }
      },
    );
  },
};
