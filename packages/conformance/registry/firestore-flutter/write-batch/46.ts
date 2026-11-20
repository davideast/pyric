import { row } from './section.ts';

export default row({
  order: 20,
  api: 'WriteBatchPlatform.update(path, data)',
  behavior: 'Enqueues update operation into atomic mutation batch.',
  featureKeys: ['update', 'batch'],
  flipped: 'unit-backed',
});
