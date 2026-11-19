import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ['Auth.verifyIdToken'],
  api: 'auth.verifyIdToken(idToken, checkRevoked?) (signature, audience, expiry, and revocation-cutoff checks)',
  behavior:
    'Rejects non-string inputs synchronously (`auth/argument-error`) and rejects malformed, missing-`kid`, non-`RS256`, tampered-signature, wrong-audience/issuer, and expired ID tokens with `auth/argument-error` or `auth/id-token-expired`, and with `checkRevoked: true` rejects tokens issued prior to the user revocation cutoff with `auth/id-token-revoked`.',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: ['admin-auth-verify-id-token-errors', 'admin-auth-revoke-refresh-tokens'],
  conformanceTests: [
    'packages/pyric-admin/test/auth/oracle-conformance.test.ts',
    'packages/pyric-admin/test/auth/verify-token.test.ts',
    'packages/pyric-admin/src/auth/oracle-admin-answers.test.ts',
  ],
  evidence:
    'Production captures `admin-auth-verify-id-token-errors` and `admin-auth-revoke-refresh-tokens` (firebase-admin 13.10.0) replayed across local and remote worker-bridge arms by `oracle-conformance.test.ts`, plus `verify-token.test.ts` and `oracle-admin-answers.test.ts`.',
  risk: ['error-code', 'stateful'],
  riskScore: 3,
  riskReasons: ['asserts JWT signature/aud/exp validation and auth/id-token-revoked'],
});
