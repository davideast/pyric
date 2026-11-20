import { row } from './section.ts';

export default row({
  order: 20,
  api: 'CollectionReference.add(data)',
  behavior: 'Generates auto-ID, writes document data, and returns DocumentReference.',
  featureKeys: ['add'],
  flipped: 'unit-backed',
});
