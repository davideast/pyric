import { row } from './section.ts';

export default row({
  order: 40,
  api: 'QueryPlatform.where(field, arrayContains: value)',
  behavior: 'Filters documents where array field contains the specified element.',
  featureKeys: ['where', 'arrayContains'],
  flipped: 'unit-backed',
});
