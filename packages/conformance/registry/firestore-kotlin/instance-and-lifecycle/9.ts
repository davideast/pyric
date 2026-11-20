import { row } from './section.ts';

export default row({
  order: 90,
  api: 'FirebaseFirestore.clearPersistence()',
  behavior: 'Clears offline client persistence cache when no active listeners exist.',
  featureKeys: ['clearPersistence'],
});
