import { row } from './section.ts';

export default row({
  order: 90,
  api: 'Query.whereField(_:in:)',
  behavior: 'Filters documents where field value matches any element in argument list.',
  featureKeys: ['whereFieldIn'],
  flipped: 'unit-backed',
});
