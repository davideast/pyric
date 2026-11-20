import { row } from './section.ts';

export default row({
  order: 10,
  api: 'CollectionReferencePlatform.doc([path])',
  behavior: 'Returns DocumentReferencePlatform under collection; auto-generates 20-char ID if path omitted.',
  featureKeys: ['doc'],
  flipped: 'unit-backed',
});
