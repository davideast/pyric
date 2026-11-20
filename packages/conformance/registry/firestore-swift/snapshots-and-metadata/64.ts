import { row } from './section.ts';

export default row({
  order: 10,
  api: 'DocumentSnapshot.exists',
  behavior: 'Boolean indicating whether document currently exists in Firestore.',
  featureKeys: ['exists'],
  flipped: 'unit-backed',
});
