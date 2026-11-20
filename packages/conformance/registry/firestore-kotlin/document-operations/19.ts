import { row } from './section.ts';

export default row({
  order: 60,
  api: 'DocumentReference.collection(path)',
  behavior: 'Returns a child CollectionReference nested under this document.',
  featureKeys: ['collection'],
  flipped: 'unit-backed',
});
