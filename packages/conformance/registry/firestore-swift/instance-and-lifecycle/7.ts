import { row } from './section.ts';

export default row({
  order: 70,
  api: 'Firestore.document(_:)',
  behavior: 'Instantiates a DocumentReference pointing to the slash-delimited document path.',
  featureKeys: ['document'],
  flipped: 'unit-backed',
});
