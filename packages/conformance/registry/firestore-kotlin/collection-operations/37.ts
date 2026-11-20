import { row } from './section.ts';

export default row({
  order: 10,
  api: 'CollectionReference.document([path])',
  behavior: 'Returns DocumentReference under collection; auto-generates 20-char ID if path omitted.',
  featureKeys: ['document'],
  flipped: 'unit-backed',
});
