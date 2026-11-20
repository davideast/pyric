import { row } from './section.ts';

export default row({
  order: 100,
  api: 'Query.whereField(_:notIn:)',
  behavior: 'Filters documents where field value matches none in argument list.',
  featureKeys: ['whereFieldNotIn'],
  flipped: 'unit-backed',
});
