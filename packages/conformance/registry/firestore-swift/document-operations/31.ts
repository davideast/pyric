import { row } from './section.ts';

export default row({
  order: 100,
  api: 'DocumentReference.delete()',
  behavior: 'Deletes document at reference path from Firestore database.',
  featureKeys: ['delete'],
  flipped: 'unit-backed',
});
