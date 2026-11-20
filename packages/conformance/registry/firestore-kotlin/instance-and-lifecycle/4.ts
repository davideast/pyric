import { row } from './section.ts';

export default row({
  order: 40,
  api: 'FirebaseFirestore.document(path)',
  behavior: 'Instantiates a DocumentReference pointing to the slash-delimited path.',
  featureKeys: ['document'],
  flipped: 'unit-backed',
});
