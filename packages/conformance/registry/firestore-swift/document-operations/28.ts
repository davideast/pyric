import { row } from './section.ts';

export default row({
  order: 70,
  api: 'DocumentReference.setData(_:merge:)',
  behavior: 'Merges payload fields into existing document without overwriting unspecified fields.',
  featureKeys: ['setDataMerge'],
  flipped: 'unit-backed',
});
