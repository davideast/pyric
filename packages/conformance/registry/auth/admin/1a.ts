import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ['getAuth'],
  api: 'getAuth(app) (explicit app routing, per-app handle caching, and post-deleteApp rejection)',
  behavior:
    'Routes `getAuth(app)` across in-process and remote worker sandboxes (`auth.app === app`), caches one `Auth` handle per active `PyricAdminApp` (`getAuth(app) === getAuth(app)`), isolates handles across apps, rejects non-`PyricAdminApp` inputs with `TypeError`, and throws `app/app-deleted` synchronously after `deleteApp(app)`.',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: ['admin-auth-getauth-app-lifecycle'],
  conformanceTests: [
    'packages/pyric-admin/test/auth/oracle-conformance.test.ts',
    'packages/pyric-admin/test/auth/auth-service.test.ts',
    'packages/pyric-admin/test/app/registry.test.ts',
  ],
  evidence:
    'Production capture `admin-auth-getauth-app-lifecycle` (firebase-admin 13.10.0) replayed across local and remote worker-bridge arms by `oracle-conformance.test.ts`, plus brand and lifecycle checks in `auth-service.test.ts` and `registry.test.ts`.',
  risk: ['error-code', 'stateful'],
  riskScore: 3,
  riskReasons: ['asserts per-app handle caching, app brand check, and synchronous app/app-deleted'],
});
