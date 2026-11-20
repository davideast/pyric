import { row } from './section.ts';

export default row({
  order: 10,
  api: 'Query.whereField(_:isEqualTo:)',
  behavior: 'Filters documents matching exact field equality.',
  featureKeys: ['whereFieldEqualTo'],
  flipped: 'unit-backed',
});
