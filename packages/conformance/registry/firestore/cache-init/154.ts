import { row } from './section.ts';

export default row({
  order: 100,
  featureKeys: ['documentSnapshotFromJSON', 'querySnapshotFromJSON', 'onSnapshotResume'],
  api: 'documentSnapshotFromJSON / querySnapshotFromJSON / onSnapshotResume',
  behavior:
    'Serializes committed `DocumentSnapshot.toJSON()` and `QuerySnapshot.toJSON()` raw wire data into `firestore/documentSnapshot/1.0` and `firestore/querySnapshot/1.0` bundle envelopes (throwing `failed-precondition` when `metadata.hasPendingWrites` is true), validates JSON schemas and 1-document / 1-query / client-`NOT SUPPORTED` bounds on `documentSnapshotFromJSON` / `querySnapshotFromJSON` (`metadata.fromCache === false`, query comparator order, optional `FirestoreDataConverter`), and validates `normalizeSnapshotJsonFields` synchronously before resuming listeners via `onSnapshotResume` (`metadata.fromCache === true`, optional `converter`)',
  status: 'conforms',
  automation: 'oracle-backed',
  evidence:
    '`unit:firestore/ssr-snapshots.test.ts`, `unit:firestore/snapshot-resume.test.ts`, `unit:firestore/sandbox/ssr-bundle-encoder.test.ts`, oracle: `firestore-offline-bundle-ssr-and-clear-persistence.json` replayed across in-page, SharedWorker, and Node-hosted planes.',
  oracleObservations: ['firestore-offline-bundle-ssr-and-clear-persistence'],
  conformanceTests: [
    'packages/pyric/test/firestore/ssr-snapshots.test.ts',
    'packages/pyric/test/firestore/snapshot-resume.test.ts',
    'packages/pyric/test/firestore/sandbox/ssr-bundle-encoder.test.ts',
    'packages/pyric/test/firestore/oracle-captures/firestore-offline-bundle-ssr-and-clear-persistence.test.ts',
    'packages/cli/test/serve/worker/oracle-captures/firestore-offline-bundle-ssr-and-clear-persistence.test.ts',
  ],
});
