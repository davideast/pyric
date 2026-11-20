import { row } from './section.ts';

export default row({
  order: 50,
  api: 'DocumentSnapshot.data()',
  behavior: 'Returns dictionary of document fields or nil if document does not exist.',
  featureKeys: ['data'],
  flipped: 'unit-backed',
});
