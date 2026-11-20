import { row } from './section.ts';

export default row({
  order: 40,
  api: 'DocumentSnapshot.metadata',
  behavior: 'SnapshotMetadata describing cache origin and pending write status.',
  featureKeys: ['snapshotMetadata'],
  flipped: 'unit-backed',
});
