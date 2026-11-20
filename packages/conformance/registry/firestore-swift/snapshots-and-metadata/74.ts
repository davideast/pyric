import { row } from './section.ts';

export default row({
  order: 110,
  api: 'QuerySnapshot.documents',
  behavior: 'Ordered array of QueryDocumentSnapshot instances matched by query.',
  featureKeys: ['documents'],
  flipped: 'unit-backed',
});
