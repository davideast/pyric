import { row } from './section.ts';

export default row({
  order: 80,
  api: 'DocumentReference.setData(_:mergeFields:)',
  behavior: 'Replaces only explicitly specified field paths in the target document.',
  featureKeys: ['setDataMergeFields'],
  flipped: 'unit-backed',
});
