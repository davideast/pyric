import { row } from './section.ts';

export default row({
  order: 120,
  api: 'QuerySnapshot.documentChanges',
  behavior: 'List of DocumentChange deltas since previous snapshot emission.',
  featureKeys: ['documentChanges'],
  flipped: 'unit-backed',
});
