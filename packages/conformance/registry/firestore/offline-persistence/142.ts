import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ['clearIndexedDbPersistence'],
  api: 'clearIndexedDbPersistence',
  behavior:
    'Maps to `Sandbox.clearPersistence()` before first use and after `terminate(db)` (resolving `Promise<void>` without touching un-persisted in-memory state), and throws synchronous `FirebaseError` (`failed-precondition`) when called while the `Firestore` instance is running',
  status: 'conforms',
  automation: 'oracle-backed',
  evidence:
    '`unit:firestore/persistence-network.test.ts`, oracle: `firestore-offline-bundle-ssr-and-clear-persistence.json` replayed across in-page, SharedWorker, and Node-hosted planes.',
  oracleObservations: ['firestore-offline-bundle-ssr-and-clear-persistence'],
  conformanceTests: [
    'packages/pyric/test/firestore/persistence-network.test.ts',
    'packages/pyric/test/firestore/oracle-captures/firestore-offline-bundle-ssr-and-clear-persistence.test.ts',
    'packages/cli/test/serve/worker/oracle-captures/firestore-offline-bundle-ssr-and-clear-persistence.test.ts',
  ],
});
