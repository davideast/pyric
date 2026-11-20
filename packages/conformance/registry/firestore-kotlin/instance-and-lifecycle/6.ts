import { row } from './section.ts';

export default row({
  order: 60,
  api: 'FirebaseFirestore.collectionGroup(collectionId)',
  behavior: 'Instantiates a Query spanning all collections with the specified collectionId.',
  featureKeys: ['collectionGroup'],
  flipped: 'unit-backed',
});
