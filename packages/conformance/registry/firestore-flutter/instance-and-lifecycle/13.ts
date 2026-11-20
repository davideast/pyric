import { row } from './section.ts';

export default row({
  order: 130,
  api: 'FirebaseFirestorePlatform.snapshotsInSync()',
  behavior: 'Emits an event when all active listeners have caught up to the same state.',
  featureKeys: ['snapshotsInSync'],
});
