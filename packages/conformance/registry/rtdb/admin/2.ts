import { row, adminCaptureTests } from './section.ts';

export default row({
  order: 20,
  featureKeys: ['Database.ref', 'Database.refFromURL', 'Reference.child'],
  api: 'db.ref(path?) / db.refFromURL(url) and Reference navigation (key, parent, root, child, toString, toJSON, isEqual)',
  behavior:
  'Normalizes slash-delimited paths while rejecting `db.ref("")` synchronously, validates full URLs against the database origin host in `refFromURL`, and exposes `key`, `parent`, `root`, `child(path)`, `toString()`, `toJSON()`, and `isEqual()` (including synchronous throw on `isEqual(null)`) identically across local and remote arms.',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: ['rtdb-modular-admin-ref-navigation-and-url-errors'],
  conformanceTests: [
    'packages/pyric-admin/test/database/app-and-url-parity.test.ts',
    'packages/pyric-admin/test/database/firebase-admin-differential.test.ts',
    ...adminCaptureTests,
  ],
  evidence:
  'Production capture `rtdb-modular-admin-ref-navigation-and-url-errors` records root/nested Reference navigation, `refFromURL` routing and host/fragment/malformed URL throws, `db.ref("")`, and `isEqual(null)`; replayed verbatim across in-process, SharedWorker, and Node host arms alongside `firebase-admin-differential.test.ts` and `app-and-url-parity.test.ts`.',
  risk: ['specific-value'],
  riskScore: 2,
  riskReasons: ['asserts Reference URL formatting, host validation, and equality'],
});
