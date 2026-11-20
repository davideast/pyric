import { row } from './section.ts';

export default row({
  order: 50,
  api: 'FirebaseFirestorePlatform.collection(path)',
  behavior: 'Instantiates a CollectionReferencePlatform pointing to the slash-delimited path.',
  featureKeys: ['collection'],
  flipped: 'unit-backed',
});
