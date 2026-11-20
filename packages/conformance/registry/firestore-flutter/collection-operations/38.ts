import { row } from './section.ts';

export default row({
  order: 20,
  api: 'CollectionReferencePlatform.add(data)',
  behavior: 'Generates auto-ID, writes document data, and returns DocumentReferencePlatform.',
  featureKeys: ['add'],
  flipped: 'unit-backed',
});
