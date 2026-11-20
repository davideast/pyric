import { row } from './section.ts';

export default row({
  order: 60,
  api: 'CollectionReference.addDocument(data:)',
  behavior: 'Auto-generates document ID, writes data payload, and returns document reference.',
  featureKeys: ['addDocument'],
  flipped: 'unit-backed',
});
