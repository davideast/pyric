import { row } from './section.ts';

export default row({
  order: 110,
  api: 'DocumentReference.addSnapshotListener(_:)',
  behavior: 'Attaches real-time closure listener receiving DocumentSnapshot updates.',
  featureKeys: ['addSnapshotListener'],
  flipped: 'unit-backed',
});
