import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_SNAPSHOTS_SUITE, row } from './section.ts';

export default row({
  order: 100,
  api: 'SnapshotMetadata (hasPendingWrites, isFromCache)',
  behavior: 'Flags indicating uncommitted local writes and cache data origin.',
  featureKeys: ['hasPendingWrites', 'isFromCache'],
  status: 'conforms',
  oracleObservations: [
    'firestore-swift-crud-merge-sentinels-and-codecs',
    'firestore-swift-batches-transactions-offline-and-errors',
  ],
  evidence: 'FirebaseFirestore Swift specification. When the bridge connection drops, a listener registered with includeMetadataChanges receives its last documents with isFromCache true and no changes, and its first snapshot after re-attach has isFromCache false; a listener without includeMetadataChanges receives neither, as production raises a metadata-only change only to listeners that include metadata changes. Reconnect tests: `BridgeReconnectTests.swift`.',
  tests: [
    'packages/swift-client/Tests/PyricFirestoreTests/BridgeReconnectTests.swift',
    LIVE_HOST_SNAPSHOTS_SUITE,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
