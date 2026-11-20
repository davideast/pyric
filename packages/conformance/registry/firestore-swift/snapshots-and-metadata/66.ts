import { row } from './section.ts';

export default row({
  order: 30,
  api: 'DocumentSnapshot.reference',
  behavior: 'DocumentReference pointing to the snapshot document location.',
  featureKeys: ['reference'],
  flipped: 'unit-backed',
});
