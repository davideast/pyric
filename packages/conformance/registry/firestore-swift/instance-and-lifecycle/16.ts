import { row } from './section.ts';

export default row({
  order: 160,
  api: 'Firestore.clearPersistence()',
  behavior: 'Clears offline client persistence cache when no active listeners exist.',
  featureKeys: ['clearPersistence'],
});
