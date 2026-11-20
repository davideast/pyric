import { row } from './section.ts';

export default row({
  order: 70,
  api: 'FirebaseFirestorePlatform.writeBatch()',
  behavior: 'Instantiates a WriteBatchPlatform for atomic batched mutations.',
  featureKeys: ['writeBatch'],
  flipped: 'unit-backed',
});
