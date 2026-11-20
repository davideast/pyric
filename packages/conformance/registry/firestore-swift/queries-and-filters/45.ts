import { row } from './section.ts';

export default row({
  order: 50,
  api: 'Query.whereField(_:isGreaterThan:)',
  behavior: 'Filters documents where field is strictly greater than value.',
  featureKeys: ['whereFieldGreaterThan'],
  flipped: 'unit-backed',
});
