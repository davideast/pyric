import { row } from './section.ts';

export default row({
  order: 30,
  api: 'WriteBatch.setData(_:forDocument:mergeFields:)',
  behavior: 'Enqueues selective field merge operation into atomic mutation batch.',
  featureKeys: ['batchSetDataMergeFields'],
  flipped: 'unit-backed',
});
