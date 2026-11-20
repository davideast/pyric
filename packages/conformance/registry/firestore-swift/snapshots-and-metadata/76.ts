import { row } from './section.ts';

export default row({
  order: 130,
  api: 'QuerySnapshot.documentChanges(includeMetadataChanges:)',
  behavior: 'List of DocumentChange deltas including metadata-only changes.',
  featureKeys: ['documentChangesIncludeMetadata'],
  flipped: 'unit-backed',
});
