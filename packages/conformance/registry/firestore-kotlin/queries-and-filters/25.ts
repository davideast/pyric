import { row } from './section.ts';

export default row({
  order: 50,
  api: 'Query.whereArrayContainsAny(field, values)',
  behavior: 'Filters documents where array field contains any element from the values list.',
  featureKeys: ['whereArrayContainsAny'],
  flipped: 'unit-backed',
});
