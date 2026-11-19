import { row } from './section.ts';

export default row({
  order: 100,
  featureKeys: ['documentSnapshotFromJSON', 'querySnapshotFromJSON', 'onSnapshotResume'],
  api: 'documentSnapshotFromJSON / querySnapshotFromJSON / onSnapshotResume',
  behavior:
    'Serializes `DocumentSnapshot.toJSON()` and `QuerySnapshot.toJSON()` into `firestore/documentSnapshot/1.0` and `firestore/querySnapshot/1.0` bundle envelopes, synchronously hydrates active snapshots via `documentSnapshotFromJSON` / `querySnapshotFromJSON` (`metadata.fromCache === false`), and resumes listeners via `onSnapshotResume` delivering initial cached snapshots (`metadata.fromCache === true`)',
  status: 'conforms',
  automation: 'oracle-backed',
  evidence:
    '`unit:firestore/ssr-snapshots.test.ts`, oracle: `firestore-offline-bundle-ssr-and-clear-persistence.json` replayed across in-page, SharedWorker, and Node-hosted planes.',
  oracleObservations: ['firestore-offline-bundle-ssr-and-clear-persistence'],
  conformanceTests: [
    'packages/pyric/test/firestore/ssr-snapshots.test.ts',
    'packages/pyric/test/firestore/sandbox/ssr-bundle-encoder.test.ts',
    'packages/pyric/test/firestore/oracle-captures/firestore-offline-bundle-ssr-and-clear-persistence.test.ts',
    'packages/cli/test/serve/worker/oracle-captures/firestore-offline-bundle-ssr-and-clear-persistence.test.ts',
  ],
});
