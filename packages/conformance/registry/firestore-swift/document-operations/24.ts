import { row } from './section.ts';

export default row({
  order: 30,
  api: 'DocumentReference.parent',
  behavior: 'Returns the parent CollectionReference containing this document.',
  featureKeys: ['parent'],
  flipped: 'unit-backed',
});
