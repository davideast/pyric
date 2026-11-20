import { row } from './section.ts';

export default row({
  order: 80,
  api: 'Query.whereField(_:arrayContainsAny:)',
  behavior: 'Filters documents where array field contains any element from argument list.',
  featureKeys: ['whereFieldArrayContainsAny'],
  flipped: 'unit-backed',
});
