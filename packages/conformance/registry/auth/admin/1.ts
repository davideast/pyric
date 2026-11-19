import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ['getAuth'],
  api: 'getAuth() (default app resolution and app/no-app)',
  behavior:
    'Calling `getAuth()` with no argument resolves the initialized `[DEFAULT]` `PyricAdminApp` to an `Auth` handle, and throws `FirebaseAppError` `app/no-app` with the upstream `[DEFAULT]` message when no default app exists.',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: [
    'admin-app-accessors-resolve-default',
    'admin-app-no-app-error',
  ],
  conformanceTests: [
    'packages/pyric-admin/test/app/oracle-conformance.test.ts',
    'packages/pyric-admin/test/app/default-service-app.test.ts',
    'packages/pyric-admin/test/auth/auth-service.test.ts',
  ],
  evidence:
    'Production captures `admin-app-accessors-resolve-default` and `admin-app-no-app-error` (firebase-admin 13.10.0) replayed by `oracle-conformance.test.ts`, `default-service-app.test.ts`, and `auth-service.test.ts`.',
  risk: ['error-code', 'stateful'],
  riskScore: 3,
  riskReasons: ['asserts default-app resolution and app/no-app error code'],
});
