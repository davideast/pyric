import { row } from './section.ts';

export default row({
  order: 120,
  api: 'FirebaseFirestore.waitForPendingWrites()',
  behavior: 'Resolves when all locally initiated writes have been committed by the server.',
  featureKeys: ['waitForPendingWrites'],
});
