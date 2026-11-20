import { row } from './section.ts';

export default row({
  order: 10,
  api: 'WriteBatch.setData(_:forDocument:)',
  behavior: 'Enqueues set overwrite operation into atomic mutation batch.',
  featureKeys: ['batchSetData'],
  flipped: 'unit-backed',
});
