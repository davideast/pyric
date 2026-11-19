import { row } from './section.ts';

export default row({
  order: 40,
  behavior:
    'An EMPTY password throws `auth/missing-password` (`Firebase: Error (auth/missing-password).`), fired before the user-DB lookup across unknown email addresses and existing email-password accounts without mutating `auth.currentUser` or firing `onAuthStateChanged` / `onIdTokenChanged`.',
  status: 'conforms',
  evidence:
    '`oracle:auth-signin-empty-password-error` (fb-js-sdk 12.19.0: `code: "auth/missing-password"`, `message: "Firebase: Error (auth/missing-password)."` across unknown and existing emails with zero listener fires, replayed unpinned in `unit:auth-signin-empty-password.test.ts` across in-page, SharedWorker, and Node-hosted WebSocket planes); `unit:sandbox-cluster-b9-b12.test.ts` (AUTH-B11); `unit:password-sign-in.test.ts`.',
  risk: ['specific-value', 'error-code', 'listener'],
  riskScore: 7,
  riskReasons: [
    'asserts 1 specific value(s)',
    'asserts Firebase error code(s): `auth/missing-password`',
    'asserts listener semantics',
  ],
  automation: 'oracle-backed',
  oracleObservations: ['auth-signin-empty-password-error'],
  conformanceTests: [
    'packages/pyric/test/auth/oracle-captures/auth-signin-empty-password.test.ts',
    'packages/cli/test/serve/worker/oracle-captures/auth-signin-empty-password.test.ts',
    'packages/pyric/test/auth/sandbox-cluster-b9-b12.test.ts',
    'packages/pyric/test/auth/sandbox/password-sign-in.test.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AUTH-15A',
      observation: 'auth-signin-empty-password-error',
      expect: {
        unknownMatchesExisting: {
          sameCode: true,
          sameMessage: true,
        },
      },
      probe: 'packages/pyric/test/auth/oracle-captures/auth-signin-empty-password.test.ts',
      guards:
        'signInWithEmailAndPassword(auth, email, "") throws auth/missing-password with Firebase: Error (auth/missing-password). across unknown and existing emails without firing listeners.',
    },
  ],
  rowNumber: 15,
});
