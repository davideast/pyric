import { row } from './section.ts';

export default row({
  order: 130,
  featureKeys: ['Auth.createSessionCookie', 'Auth.verifySessionCookie'],
  api: 'auth.createSessionCookie(idToken, options) / auth.verifySessionCookie(sessionCookie, checkRevoked?)',
  behavior:
    'Validates `expiresIn` bounds (`5` minutes to `14` days, floored to whole seconds) and input ID token validity/standing, mints signed sandbox session-cookie JWTs with `iss: https://session.firebase.google.com/<projectId>` under a dedicated key distinct from ID tokens, and verifies session cookies with optional `checkRevoked` (`auth/session-cookie-expired`, `auth/session-cookie-revoked`, `auth/user-disabled`, `auth/user-not-found`, `auth/argument-error`) across in-process and remote arms.',
  status: 'conforms',
  automation: 'unit-backed',
  conformanceTests: [
    'packages/pyric-admin/src/auth/auth.test.ts',
    'packages/pyric-admin/test/auth/session-cookie.test.ts',
    'packages/pyric-admin/test/auth/local-auth.test.ts',
    'packages/pyric-admin/test/auth/remote-auth.test.ts',
    'packages/pyric-admin/test/auth/argument-differential.test.ts',
  ],
  evidence:
    'Verified on local and hosted worker-bridge remote arms in `session-cookie.test.ts`, `local-auth.test.ts`, `remote-auth.test.ts`, and `auth.test.ts`, plus offline differential parity against installed `firebase-admin` in `argument-differential.test.ts`.',
  risk: ['error-code', 'stateful', 'specific-value'],
  riskScore: 4,
  riskReasons: [
    'asserts session-cookie vs ID-token isolation and firebase-admin error codes',
    'asserts checkRevoked against tokensValidAfterMs, disabled, and deleted accounts on both arms',
  ],
});
