import { row } from './section.ts';

export default row({
  order: 130,
  api: 'Query.endAt(values) / endBefore(values)',
  behavior: 'Positions ending cursor boundary using field values.',
  featureKeys: ['endAt', 'endBefore'],
  flipped: 'unit-backed',
});
