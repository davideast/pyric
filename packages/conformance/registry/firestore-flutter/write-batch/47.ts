import { row } from './section.ts';

export default row({
  order: 30,
  api: 'WriteBatchPlatform.delete(path)',
  behavior: 'Enqueues delete operation into atomic mutation batch.',
  featureKeys: ['delete', 'batch'],
  flipped: 'unit-backed',
});
