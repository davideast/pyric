import { row } from './section.ts';

export default row({
  order: 120,
  api: 'FirebaseFirestorePlatform.waitForPendingWrites()',
  behavior: 'Resolves when all locally initiated writes have been committed by the server.',
  featureKeys: ['waitForPendingWrites'],
});
