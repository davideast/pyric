import { row } from './section.ts';

export default row({
  order: 90,
  featureKeys: ['loadBundle', 'namedQuery', 'LoadBundleTask'],
  api: 'loadBundle / namedQuery',
  behavior:
    'Decodes length-prefixed JSON bundles (including `firebase-admin` `BundleBuilder` protobuf Timestamp/uint64 forms, `unaryFilter`, `startAt`/`endAt` cursors, `VectorValue`, and escaped `FieldPath` segments) from `string`, `Uint8Array`, or `ReadableStream` into local cache and named-query state with `LoadBundleTask.onProgress` milestones, skips older/equal `createTime` bundles for the same id and stale document `updateTime` entries, rejects raw `ArrayBuffer` synchronously with `FirebaseError` (`invalid-argument`), and rejects malformed payloads asynchronously with a plain `Error`',
  status: 'conforms',
  automation: 'oracle-backed',
  evidence:
    '`unit:firestore/bundles.test.ts`, `unit:firestore/sandbox/bundle-wire.test.ts`, oracle: `firestore-offline-bundle-ssr-and-clear-persistence.json` replayed across in-page, SharedWorker, and Node-hosted planes.',
  oracleObservations: ['firestore-offline-bundle-ssr-and-clear-persistence'],
  conformanceTests: [
    'packages/pyric/test/firestore/bundles.test.ts',
    'packages/pyric/test/firestore/sandbox/bundle-wire.test.ts',
    'packages/pyric/test/firestore/oracle-captures/firestore-offline-bundle-ssr-and-clear-persistence.test.ts',
    'packages/cli/test/serve/worker/oracle-captures/firestore-offline-bundle-ssr-and-clear-persistence.test.ts',
  ],
});
