import { row } from './section.ts';

export default row({
  order: 90,
  api: 'Firestore.collectionGroup(_:)',
  behavior: 'Instantiates a Query spanning all collections with the matching collectionID.',
  featureKeys: ['collectionGroup'],
  flipped: 'unit-backed',
});
