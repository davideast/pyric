import { row } from './section.ts';

export default row({
  order: 170,
  api: 'Query.end(before:) / end(at:)',
  behavior: 'Positions ending cursor using ordered field values.',
  featureKeys: ['endBefore', 'endAt'],
  flipped: 'unit-backed',
});
