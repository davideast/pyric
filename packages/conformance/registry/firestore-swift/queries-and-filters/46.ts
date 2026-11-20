import { row } from './section.ts';

export default row({
  order: 60,
  api: 'Query.whereField(_:isGreaterThanOrEqualTo:)',
  behavior: 'Filters documents where field is greater than or equal to value.',
  featureKeys: ['whereFieldGreaterThanOrEqualTo'],
  flipped: 'unit-backed',
});
