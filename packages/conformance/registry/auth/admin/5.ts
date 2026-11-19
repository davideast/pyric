import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ['Auth.createUser'],
  api: 'auth.createUser(properties)',
  behavior:
    'Creates a user in the shared client/admin identity store (generating a UID when omitted), validates UID, email (`auth/invalid-email`), and password length >= 6 (`auth/invalid-password`), and rejects duplicate UIDs (`auth/uid-already-exists`) or duplicate emails (`auth/email-already-exists`).',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: ['auth-request-auth-per-sign-in'],
  conformanceTests: [
    'packages/pyric-admin/src/auth/oracle-admin-answers.test.ts',
    'packages/pyric-admin/test/auth/local-auth.test.ts',
    'packages/pyric-admin/test/auth/remote-auth.test.ts',
  ],
  evidence:
    'Production capture `auth-request-auth-per-sign-in` (`behavior.admin.createUser*` and `freshPasswordUserRecord`) replayed by `oracle-admin-answers.test.ts`, `local-auth.test.ts`, and `remote-auth.test.ts`.',
  risk: ['error-code', 'stateful'],
  riskScore: 4,
  riskReasons: ['asserts validation and uniqueness error codes', 'asserts UserRecord shape'],
});
