import { row } from './section.ts';

export default row({
  order: 80,
  api: 'Firestore.collection(_:)',
  behavior: 'Instantiates a CollectionReference pointing to the slash-delimited collection path.',
  featureKeys: ['collection'],
  flipped: 'unit-backed',
});
