import { row } from './section.ts';

export default row({
  order: 120,
  api: 'DocumentReference.addSnapshotListener(includeMetadataChanges:listener:)',
  behavior: 'Listens to document snapshot updates including metadata-only transitions.',
  featureKeys: ['addSnapshotListenerMetadata'],
  flipped: 'unit-backed',
});
