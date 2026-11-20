import { row } from './section.ts';

export default row({
  order: 40,
  api: 'DocumentReference.collection(_:)',
  behavior: 'Instantiates a child CollectionReference nested under this document.',
  featureKeys: ['collection'],
  flipped: 'unit-backed',
});
