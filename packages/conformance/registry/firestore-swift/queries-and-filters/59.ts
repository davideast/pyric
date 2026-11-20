import { row } from './section.ts';

export default row({
  order: 190,
  api: 'Query.end(beforeDocument:) / end(atDocument:)',
  behavior: 'Positions ending cursor using DocumentSnapshot position.',
  featureKeys: ['endBeforeDocument', 'endAtDocument'],
  flipped: 'unit-backed',
});
