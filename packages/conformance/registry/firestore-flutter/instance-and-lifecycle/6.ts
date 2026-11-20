import { row } from './section.ts';

export default row({
  order: 60,
  api: 'FirebaseFirestorePlatform.collectionGroup(collectionId)',
  behavior: 'Instantiates a QueryPlatform spanning all collections with the specified collectionId.',
  featureKeys: ['collectionGroup'],
  flipped: 'unit-backed',
});
