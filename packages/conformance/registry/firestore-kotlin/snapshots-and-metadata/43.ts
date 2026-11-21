import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_SNAPSHOTS_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 50,
  api: 'SnapshotMetadata (hasPendingWrites, isFromCache)',
  behavior: 'Exposes local cache and uncommitted pending write status on snapshots.',
  featureKeys: ['metadata'],
  status: 'conforms',
  oracleObservations: [
    'firestore-kotlin-crud-merge-sentinels-and-codecs',
    'firestore-kotlin-batches-transactions-offline-and-errors',
  ],
  evidence: 'com.google.firebase.firestore specification. When the bridge connection drops, a listener registered with MetadataChanges.INCLUDE receives its last documents with isFromCache true, and its first snapshot after re-attach has isFromCache false; a listener with MetadataChanges.EXCLUDE receives neither, as production raises a metadata-only change only to listeners that include metadata changes. Reconnect tests: `BridgeReconnectTest.kt`.',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/bridge/BridgeReconnectTest.kt',
    LIVE_HOST_SNAPSHOTS_SUITE,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
