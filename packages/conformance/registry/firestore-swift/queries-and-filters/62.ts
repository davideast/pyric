import { row } from './section.ts';

export default row({
  order: 220,
  api: 'Query.addSnapshotListener(includeMetadataChanges:listener:)',
  behavior: 'Attaches real-time query listener receiving metadata-only change notifications.',
  featureKeys: ['addQuerySnapshotListenerMetadata'],
  flipped: 'unit-backed',
});
