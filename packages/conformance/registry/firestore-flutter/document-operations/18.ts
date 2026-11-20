import { row } from './section.ts';

export default row({
  order: 50,
  api: 'DocumentReferencePlatform.delete()',
  behavior: 'Deletes document at reference path from Firestore database.',
  featureKeys: ['delete'],
  flipped: 'unit-backed',
});
