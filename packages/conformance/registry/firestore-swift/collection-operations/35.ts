import { row } from './section.ts';

export default row({
  order: 10,
  api: 'CollectionReference.collectionID',
  behavior: 'Returns the collection identifier string.',
  featureKeys: ['collectionID'],
  flipped: 'unit-backed',
});
