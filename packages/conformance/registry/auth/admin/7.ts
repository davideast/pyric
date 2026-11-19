import { row } from './section.ts';

export default row({
  order: 90,
  featureKeys: ['Auth.setCustomUserClaims'],
  api: 'auth.setCustomUserClaims(uid, customUserClaims)',
  behavior:
    'Sets or clears (`null`) developer custom claims on an existing account, enforcing the 1000-character serialized payload limit (`auth/claims-too-large`), reserved claim names (`auth/reserved-claim`), and user existence (`auth/user-not-found`).',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: ['auth-request-auth-per-sign-in'],
  conformanceTests: [
    'packages/pyric-admin/src/auth/oracle-admin-answers.test.ts',
    'packages/pyric-admin/test/auth/validation.test.ts',
  ],
  evidence:
    'Production capture `auth-request-auth-per-sign-in` (`setCustomUserClaims1100`, `setCustomUserClaimsReserved`, `setCustomUserClaimsMissing`) replayed by `oracle-admin-answers.test.ts` and `validation.test.ts`.',
  risk: ['error-code', 'specific-value'],
  riskScore: 3,
  riskReasons: ['asserts 1000-char payload limit and reserved-claim rejections'],
});
