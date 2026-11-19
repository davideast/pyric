import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ['getFirestore'],
  api: 'getFirestore(app) (rules-bypass routing, per-app handle caching, and post-deleteApp factory rejection)',
  behavior:
    'Resolves an explicit `PyricAdminApp` to a rules-bypassing Admin `Firestore` handle across in-process and remote worker sandboxes, caches one handle per active app (`getFirestore(app) === getFirestore(app)`), rejects non-`PyricAdminApp` inputs with `TypeError`, and throws `FirebaseAppError` `app/app-deleted` synchronously on `getFirestore(app)` after `deleteApp(app)` while leaving previously retained `Firestore` handles and sibling apps usable.',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: ['firestore-admin-getfirestore-bypass-and-lifecycle'],
  conformanceTests: [
    'packages/pyric-admin/test/firestore/oracle-conformance.test.ts',
    'packages/pyric-admin/test/firestore/firestore/admin-bypass.test.ts',
    'packages/pyric-admin/test/firestore/app-brand-validation.test.ts',
    'packages/pyric-admin/test/remote/remote-firestore.test.ts',
    'packages/pyric-admin/test/app/registry.test.ts',
  ],
  evidence:
    'Production capture `firestore-admin-getfirestore-bypass-and-lifecycle` (firebase 12.19.0, firebase-admin 13.10.0) replayed across local and remote arms in `oracle-conformance.test.ts`, plus `admin-bypass.test.ts`, `app-brand-validation.test.ts`, `remote-firestore.test.ts`, and `registry.test.ts`.',
  risk: ['error-code', 'stateful'],
  riskScore: 3,
  riskReasons: ['asserts rules-bypass semantics, handle caching, and app/app-deleted'],
});
