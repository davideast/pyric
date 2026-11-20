import { row } from './section.ts';

export default row({
  order: 40,
  api: 'WriteBatch.updateData(_:forDocument:)',
  behavior: 'Enqueues update operation into atomic mutation batch.',
  featureKeys: ['batchUpdateData'],
  flipped: 'unit-backed',
});
