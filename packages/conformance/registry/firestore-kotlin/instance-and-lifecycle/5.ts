import { row } from './section.ts';

export default row({
  order: 50,
  api: 'FirebaseFirestore.collection(path)',
  behavior: 'Instantiates a CollectionReference pointing to the slash-delimited path.',
  featureKeys: ['collection'],
  flipped: 'unit-backed',
});
