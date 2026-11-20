import { row } from './section.ts';

export default row({
  order: 40,
  api: 'SnapshotMetadataPlatform (hasPendingWrites, isFromCache)',
  behavior: 'Exposes local cache and uncommitted pending write status on snapshots.',
  featureKeys: ['metadata'],
  evidence: 'cloud_firestore_platform_interface specification. When the bridge connection drops, a listener registered with includeMetadataChanges receives its last documents with isFromCache true and no changes, and its first snapshot after re-attach has isFromCache false; a listener without includeMetadataChanges receives neither, as production raises a metadata-only change only to listeners that include metadata changes. Reconnect tests: `platform_reconnect_test.dart`.',
  tests: ['packages/flutter-client/test/platform_reconnect_test.dart'],
  flipped: 'unit-backed',
});
