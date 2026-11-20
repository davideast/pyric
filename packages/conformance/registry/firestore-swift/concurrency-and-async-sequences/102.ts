import { row } from './section.ts';

export default row({
  order: 20,
  api: 'Query.snapshots',
  behavior: 'AsyncSequence streaming real-time QuerySnapshot updates via Swift concurrency.',
  featureKeys: ['querySnapshotsSequence'],
  flipped: 'unit-backed',
});
