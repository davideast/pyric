import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ['Auth.revokeRefreshTokens'],
  api: 'auth.revokeRefreshTokens(uid)',
  behavior:
    'Advances the user revocation timestamp across local and remote arms so earlier ID tokens still pass `verifyIdToken(token)` / `verifyIdToken(token, false)` while failing `verifyIdToken(token, true)` with `auth/id-token-revoked`, forced client token refreshes reject with `auth/user-token-expired`, fresh post-revocation sessions pass `verifyIdToken(token, true)`, and unknown UIDs reject with `auth/user-not-found`.',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: ['admin-auth-revoke-refresh-tokens'],
  conformanceTests: [
    'packages/pyric-admin/test/auth/oracle-conformance.test.ts',
    'packages/pyric-admin/src/auth/oracle-admin-answers.test.ts',
    'packages/pyric-admin/test/auth/local-auth.test.ts',
    'packages/pyric-admin/test/auth/remote-auth.test.ts',
  ],
  evidence:
    'Production capture `admin-auth-revoke-refresh-tokens` (firebase-admin 13.10.0) replayed across local and remote worker-bridge arms by `oracle-conformance.test.ts`, plus `oracle-admin-answers.test.ts`, `local-auth.test.ts`, and `remote-auth.test.ts`.',
  risk: ['error-code', 'stateful'],
  riskScore: 3,
  riskReasons: ['asserts revocation cutoff and auth/id-token-revoked'],
});
