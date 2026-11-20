import { row } from './section.ts';

export default row({
  order: 10,
  api: 'Query.whereEqualTo(field, value)',
  behavior: 'Filters documents matching exact field equality.',
  featureKeys: ['whereEqualTo'],
  flipped: 'unit-backed',
});
