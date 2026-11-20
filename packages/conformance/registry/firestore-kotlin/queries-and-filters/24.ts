import { row } from './section.ts';

export default row({
  order: 40,
  api: 'Query.whereArrayContains(field, value)',
  behavior: 'Filters documents where array field contains the specified element.',
  featureKeys: ['whereArrayContains'],
  flipped: 'unit-backed',
});
