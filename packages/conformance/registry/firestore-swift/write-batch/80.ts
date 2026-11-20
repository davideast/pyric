import { row } from './section.ts';

export default row({
  order: 20,
  api: 'WriteBatch.setData(_:forDocument:merge:)',
  behavior: 'Enqueues set merge operation into atomic mutation batch.',
  featureKeys: ['batchSetDataMerge'],
  flipped: 'unit-backed',
});
