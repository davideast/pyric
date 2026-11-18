import type { Probe } from '../../rigs/types.ts';
import { withClientAuthProbeSession } from '../../src/auth-user-probe-session.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'admin-auth'],
  matrixRow: 'auth#56',
  rowIds: ['auth#56'],
  description:
    'user.getIdTokenResult() returns the parsed IdTokenResult shape including standard and custom claims, signInProvider, and ISO timestamp fields.',
  async observe() {
    return withClientAuthProbeSession(
      async ({ auth, authSdk, adminAuth, nextUid, nextEmail, createProbeUser }) => {
        const uid = nextUid('claims');
        const email = nextEmail('claims');
        const password = 'ProbePassword!123';
        await createProbeUser({ uid, email, password });
        await adminAuth.setCustomUserClaims(uid, { role: 'editor', tier: 2 });

        const cred = await authSdk.signInWithEmailAndPassword(auth, email, password);
        const tokenResult = await cred.user.getIdTokenResult();
        const firebaseClaim = (tokenResult.claims.firebase ?? {}) as Record<string, unknown>;

        return {
          resultKeysSorted: Object.keys(tokenResult).sort(),
          tokenIsNonEmptyString:
            typeof tokenResult.token === 'string' && tokenResult.token.length > 0,
          signInProvider: tokenResult.signInProvider,
          signInSecondFactor: tokenResult.signInSecondFactor,
          authTimeValidIso: !Number.isNaN(Date.parse(tokenResult.authTime)),
          issuedAtTimeValidIso: !Number.isNaN(Date.parse(tokenResult.issuedAtTime)),
          expirationTimeValidIso: !Number.isNaN(Date.parse(tokenResult.expirationTime)),
          customRoleClaim: tokenResult.claims.role ?? null,
          customTierClaim: tokenResult.claims.tier ?? null,
          subMatchesUid: tokenResult.claims.sub === uid,
          firebaseSignInProvider: firebaseClaim.sign_in_provider ?? null,
        };
      },
    );
  },
};
