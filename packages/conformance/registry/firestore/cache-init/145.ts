import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ['initializeFirestore'],
  api: 'initializeFirestore',
  behavior:
    'Initializes or returns the cached `Firestore` handle (`type: "firestore"`, `instanceof Firestore`, `db.app === app`) for the app, shares handle identity with `getFirestore(app)` and repeat `initializeFirestore` calls carrying equivalent settings, and throws synchronous `FirebaseError` (`failed-precondition`) when called with conflicting settings after startup',
  status: 'conforms',
  automation: 'oracle-backed',
  evidence:
    '`unit:firestore/tier1-cache-init-align.test.ts`, oracle: `firestore-offline-cache-init-index-and-refequal.json` replayed across in-page, SharedWorker, and Node-hosted planes (named-database handle sharing governed by `firestore#MD1` / `firestore#MD2`).',
  risk: ['error-code'],
  riskScore: 2,
  riskReasons: ['asserts Firebase error code(s): `failed-precondition`'],
  oracleObservations: ['firestore-offline-cache-init-index-and-refequal'],
  conformanceTests: [
    'packages/pyric/test/firestore/init-settings.test.ts',
    'packages/pyric/test/firestore/tier1-cache-init-align.test.ts',
    'packages/pyric/test/firestore/oracle-captures/firestore-offline-cache-init-index-and-refequal.test.ts',
    'packages/cli/test/serve/worker/oracle-captures/firestore-offline-cache-init-index-and-refequal.test.ts',
  ],
});
