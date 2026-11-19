import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: ['Auth.getUser', 'Auth.getUserByEmail', 'Auth.deleteUser'],
  api: 'auth.getUser(uid) / auth.getUserByEmail(email) / auth.deleteUser(uid)',
  behavior:
    'Retrieves `UserRecord` handles by UID or case-insensitive email and deletes existing accounts across local and remote arms; rejects missing accounts with `auth/user-not-found`.',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: ['auth-request-auth-per-sign-in'],
  conformanceTests: [
    'packages/pyric-admin/src/auth/oracle-admin-answers.test.ts',
    'packages/pyric-admin/test/auth/local-auth.test.ts',
    'packages/pyric-admin/test/auth/remote-auth.test.ts',
  ],
  evidence:
    'Production capture `auth-request-auth-per-sign-in` (`getUserMissing`, `getUserByEmailMissing`, `getUserByEmailOtherCase`, `deleteUserMissing`) replayed by `oracle-admin-answers.test.ts`, `local-auth.test.ts`, and `remote-auth.test.ts`.',
  risk: ['error-code', 'stateful'],
  riskScore: 3,
  riskReasons: ['asserts case-insensitive email lookup and auth/user-not-found'],
});
