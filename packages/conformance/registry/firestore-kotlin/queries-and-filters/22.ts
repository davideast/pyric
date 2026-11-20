import { row } from './section.ts';

export default row({
  order: 20,
  api: 'Query.whereNotEqualTo(field, value)',
  behavior: 'Filters documents where field does not equal specified value.',
  featureKeys: ['whereNotEqualTo'],
  flipped: 'unit-backed',
});
