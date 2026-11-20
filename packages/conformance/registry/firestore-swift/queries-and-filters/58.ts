import { row } from './section.ts';

export default row({
  order: 180,
  api: 'Query.start(atDocument:) / start(afterDocument:)',
  behavior: 'Positions starting cursor using DocumentSnapshot position.',
  featureKeys: ['startAtDocument', 'startAfterDocument'],
  flipped: 'unit-backed',
});
