import { row } from './section.ts';

export default row({
  order: 70,
  api: 'Query.whereField(_:arrayContains:)',
  behavior: 'Filters documents where array field contains argument element.',
  featureKeys: ['whereFieldArrayContains'],
  flipped: 'unit-backed',
});
