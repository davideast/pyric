import { row } from './section.ts';

export default row({
  order: 60,
  api: 'DocumentReferencePlatform.collection(subPath)',
  behavior: 'Returns a child CollectionReferencePlatform nested under this document.',
  featureKeys: ['collection'],
  flipped: 'unit-backed',
});
