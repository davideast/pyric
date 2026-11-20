import { row } from './section.ts';

export default row({
  order: 20,
  api: 'AggregateQuery.aggregate(sum, average)',
  behavior: 'Computes server-side numeric sum and average across matched query documents.',
  featureKeys: ['aggregate'],
  flipped: 'unit-backed',
});
