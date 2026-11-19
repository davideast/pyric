import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ['Auth.verifyIdToken'],
  api: 'auth.verifyIdToken(idToken, checkRevoked?) (decoded claims, custom-token rejection, and disabled/deleted checks)',
  behavior:
    'Decodes standard and custom ID token claims (`uid === sub`, `auth_time`, `exp - iat`, `firebase.sign_in_provider`, `firebase.identities`), rejects custom tokens with `auth/argument-error`, resolves disabled users when `checkRevoked` is omitted or false, and with `checkRevoked: true` rejects disabled (`auth/user-disabled`) and deleted (`auth/user-not-found`) accounts.',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: ['auth-request-auth-per-sign-in'],
  conformanceTests: [
    'packages/pyric-admin/src/auth/oracle-admin-answers.test.ts',
    'packages/pyric-admin/src/auth/verify-id-token-claims.test.ts',
  ],
  evidence:
    'Production capture `auth-request-auth-per-sign-in` (`verifyIdTokenDecoded`, `verifyIdTokenOfCustomToken`, `verifyIdTokenNoCheckDisabled`, `verifyIdTokenCheckRevokedDisabled`, `verifyIdTokenCheckRevokedDeleted`) replayed by `oracle-admin-answers.test.ts` and `verify-id-token-claims.test.ts`.',
  risk: ['error-code', 'specific-field'],
  riskScore: 4,
  riskReasons: ['asserts decoded token claims', 'asserts custom-token and disabled/deleted checkRevoked error codes'],
});
