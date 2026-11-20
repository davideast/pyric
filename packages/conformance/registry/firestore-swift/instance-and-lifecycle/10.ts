import { row } from './section.ts';

export default row({
  order: 100,
  api: 'Firestore.batch()',
  behavior: 'Instantiates a WriteBatch for atomic batched mutations.',
  featureKeys: ['batch'],
  flipped: 'unit-backed',
});
