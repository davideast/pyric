import { row } from './section.ts';

export default row({
  order: 160,
  api: 'Query.start(at:) / start(after:)',
  behavior: 'Positions starting cursor using ordered field values.',
  featureKeys: ['startAt', 'startAfter'],
  flipped: 'unit-backed',
});
