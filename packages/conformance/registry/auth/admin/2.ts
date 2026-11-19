import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ['Auth.createCustomToken'],
  api: 'auth.createCustomToken(uid, developerClaims?)',
  behavior:
    'Validates `uid` (non-empty string up to 128 chars) and `developerClaims` (plain non-null object free of reserved claims such as `aud`, `iss`, `sub`, `iat`, `exp`, while permitting `firebase`) synchronously with `auth/argument-error`, and mints an RS256 sandbox custom-token JWT exchangeable via `signInWithCustomToken`.',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: ['auth-request-auth-per-sign-in'],
  conformanceTests: [
    'packages/pyric-admin/src/auth/oracle-admin-answers.test.ts',
    'packages/pyric-admin/src/auth/custom-token-exchange.test.ts',
  ],
  evidence:
    'Production capture `auth-request-auth-per-sign-in` (`behavior.admin.createCustomToken*`) replayed by `oracle-admin-answers.test.ts`, plus end-to-end client exchange in `custom-token-exchange.test.ts`.',
  risk: ['error-code', 'specific-value'],
  riskScore: 4,
  riskReasons: ['asserts synchronous auth/argument-error checks', 'asserts custom-token JWT shape'],
});
