import { row } from './section.ts';

export default row({
  order: 10,
  api: 'DocumentReference.snapshots',
  behavior: 'AsyncSequence streaming real-time DocumentSnapshot updates via Swift concurrency.',
  featureKeys: ['documentSnapshotsSequence'],
  flipped: 'unit-backed',
});
