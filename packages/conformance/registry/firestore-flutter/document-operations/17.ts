import { row } from './section.ts';

export default row({
  order: 40,
  api: 'DocumentReferencePlatform.update(data)',
  behavior: 'Updates specified fields in an existing document; fails if document does not exist.',
  featureKeys: ['update'],
  flipped: 'unit-backed',
});
