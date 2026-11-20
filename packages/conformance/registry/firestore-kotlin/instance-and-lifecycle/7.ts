import { row } from './section.ts';

export default row({
  order: 70,
  api: 'FirebaseFirestore.batch()',
  behavior: 'Instantiates a WriteBatch for atomic batched mutations.',
  featureKeys: ['batch'],
  flipped: 'unit-backed',
});
