import { row } from './section.ts';

export default row({
  order: 50,
  api: 'QueryPlatform.where(field, arrayContainsAny: values)',
  behavior: 'Filters documents where array field contains any element from the values list.',
  featureKeys: ['where', 'arrayContainsAny'],
  flipped: 'unit-backed',
});
