import { row } from './section.ts';

export default row({
  order: 60,
  api: 'DocumentReference.setData(_:)',
  behavior: 'Overwrites the target document completely with provided dictionary payload.',
  featureKeys: ['setData'],
  flipped: 'unit-backed',
});
