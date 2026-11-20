import { row } from './section.ts';

export default row({
  order: 20,
  api: 'Query.whereField(_:isNotEqualTo:)',
  behavior: 'Filters documents where field does not equal value.',
  featureKeys: ['whereFieldNotEqualTo'],
  flipped: 'unit-backed',
});
