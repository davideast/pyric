import { row } from './section.ts';

export default row({
  order: 120,
  api: 'Query.startAt(values) / startAfter(values)',
  behavior: 'Positions starting cursor boundary using field values.',
  featureKeys: ['startAt', 'startAfter'],
  flipped: 'unit-backed',
});
