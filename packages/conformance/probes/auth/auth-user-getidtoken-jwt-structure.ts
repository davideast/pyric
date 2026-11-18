import type { Probe } from '../../rigs/types.ts';
import {
  decodeJwtParts,
  deepEqualJsonValues,
  withClientAuthProbeSession,
} from '../../src/auth-user-probe-session.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'admin-auth'],
  matrixRow: 'auth#54',
  rowIds: ['auth#54'],
  description:
    'user.getIdToken() returns a three-segment base64url JWT (alg RS256, typ JWT, non-empty kid) whose decoded payload matches user.getIdTokenResult().claims.',
  async observe() {
    return withClientAuthProbeSession(
      async ({ auth, authSdk, nextUid, nextEmail, createProbeUser }) => {
        const uid = nextUid('jwt');
        const email = nextEmail('jwt');
        const password = 'ProbePassword!123';
        await createProbeUser({
          uid,
          email,
          password,
          displayName: 'Jwt Probe',
        });

        const cred = await authSdk.signInWithEmailAndPassword(auth, email, password);
        const token = await cred.user.getIdToken();
        const result = await cred.user.getIdTokenResult();
        const decoded = decodeJwtParts(token);

        const headerAlg = decoded.header.alg ?? null;
        const headerTyp = decoded.header.typ ?? null;
        const hasNonEmptyKid =
          typeof decoded.header.kid === 'string' && decoded.header.kid.length > 0;
        const payloadKeysSorted = Object.keys(decoded.payload).sort();
        const resultClaimKeysSorted = Object.keys(result.claims).sort();
        const rawExp = decoded.payload.exp ?? 0;
        const rawIat = decoded.payload.iat ?? 0;
        const expMinusIatSeconds = Number(rawExp) - Number(rawIat);

        return {
          segmentCount: decoded.segmentCount,
          allSegmentsBase64Url: decoded.allSegmentsBase64Url,
          headerAlg,
          headerTyp,
          hasNonEmptyKid,
          tokenEqualsResultToken: token === result.token,
          payloadMatchesResultClaims: deepEqualJsonValues(decoded.payload, result.claims),
          payloadKeysSorted,
          resultClaimKeysSorted,
          subMatchesUid: decoded.payload.sub === uid,
          userIdMatchesUid: decoded.payload.user_id === uid,
          emailMatchesAccount: decoded.payload.email === email,
          nameClaim: decoded.payload.name ?? null,
          expMinusIatSeconds,
        };
      },
    );
  },
};
