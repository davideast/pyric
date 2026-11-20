import { row } from './section.ts';

export default row({
  order: 50,
  api: 'DocumentReference.getDocument(source:)',
  behavior: 'Reads document snapshot from server, cache, or default source.',
  featureKeys: ['getDocument'],
  flipped: 'unit-backed',
});
