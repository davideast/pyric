import { row, adminCaptureTests } from './section.ts';

export default row({
  order: 10,
  featureKeys: ['getDatabase', 'getDatabaseWithUrl'],
  api: 'getDatabase(app?, url?) / getDatabaseWithUrl(url, app?)',
  behavior:
  'Resolves the default or explicit `PyricAdminApp`, caches handles per `(app, instanceUrl)` while rejecting mismatched URL string formats on an already-open instance, isolates named RTDB instances by URL, bypasses RTDB Security Rules as admin, throws `app/no-app` when no default app exists, throws `database/invalid-argument` (`FirebaseDatabaseError`) on an empty URL, and rejects calls after `deleteApp(app)`. When `databaseURL` is omitted from `app.options`, falls back to the project default RTDB instance rather than throwing `database/invalid-argument`.',
  status: 'diverged-documented',
  statusNote:
  'omitting app.options.databaseURL resolves the default project instance so zero-config local apps run, whereas production throws database/invalid-argument',
  automation: 'oracle-backed',
  oracleObservations: [
    'admin-app-no-app-error',
    'admin-app-getdatabase-missing-url',
    'rtdb-modular-admin-firebasedatabaseerror-and-url-binding',
  ],
  conformanceTests: [
    'packages/pyric-admin/test/app/oracle-conformance.test.ts',
    'packages/pyric-admin/test/app/registry.test.ts',
    'packages/pyric-admin/test/database/get-database-with-url.test.ts',
    'packages/pyric-admin/test/database/legacy-default-url.test.ts',
    'packages/pyric-admin/test/database/app-and-url-parity.test.ts',
    ...adminCaptureTests,
  ],
  evidence:
  'Production captures `admin-app-no-app-error`, `admin-app-getdatabase-missing-url` (firebase-admin 13.10.0), and `rtdb-modular-admin-firebasedatabaseerror-and-url-binding` alongside lifecycle and multi-instance routing tests in `registry.test.ts`, `get-database-with-url.test.ts`, `legacy-default-url.test.ts`, `app-and-url-parity.test.ts`, and 3-plane capture replays.',
  risk: ['error-code', 'stateful'],
  riskScore: 3,
  riskReasons: ['asserts instance isolation, app/no-app, and zero-config URL fallback'],
});
