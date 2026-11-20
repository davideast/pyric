import { row } from './section.ts';

export default row({
  order: 40,
  api: 'Query.whereField(_:isLessThanOrEqualTo:)',
  behavior: 'Filters documents where field is less than or equal to value.',
  featureKeys: ['whereFieldLessThanOrEqualTo'],
  flipped: 'unit-backed',
});
