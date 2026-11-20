import { row } from './section.ts';

export default row({
  order: 30,
  api: 'Query.whereField(_:isLessThan:)',
  behavior: 'Filters documents where field is strictly less than value.',
  featureKeys: ['whereFieldLessThan'],
  flipped: 'unit-backed',
});
