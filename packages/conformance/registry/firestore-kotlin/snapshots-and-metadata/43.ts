import { row } from './section.ts';

export default row({
  order: 50,
  api: 'SnapshotMetadata (hasPendingWrites, isFromCache)',
  behavior: 'Exposes local cache and uncommitted pending write status on snapshots.',
  featureKeys: ['metadata'],
  flipped: 'unit-backed',
  evidence: 'com.google.firebase.firestore specification. When the bridge connection drops, a listener registered with MetadataChanges.INCLUDE receives its last documents with isFromCache true, and its first snapshot after re-attach has isFromCache false; a listener with MetadataChanges.EXCLUDE receives neither, as production raises a metadata-only change only to listeners that include metadata changes. Reconnect tests: `BridgeReconnectTest.kt`.',
  tests: ['packages/kt-client/src/test/kotlin/dev/pyric/bridge/BridgeReconnectTest.kt'],
});
