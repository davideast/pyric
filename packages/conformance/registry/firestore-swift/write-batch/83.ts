import { row } from './section.ts';

export default row({
  order: 50,
  api: 'WriteBatch.deleteDocument(_:)',
  behavior: 'Enqueues document deletion into atomic mutation batch.',
  featureKeys: ['batchDeleteDocument'],
  flipped: 'unit-backed',
});
