import { row } from './section.ts';

export default row({
  order: 90,
  api: 'DocumentReference.updateData(_:)',
  behavior: 'Updates specified fields in an existing document; fails if document does not exist.',
  featureKeys: ['updateData'],
  flipped: 'unit-backed',
});
