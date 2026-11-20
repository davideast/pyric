import { row } from './section.ts';

export default row({
  order: 190,
  api: 'Firestore.addSnapshotsInSyncListener(_:)',
  behavior: 'Attaches a callback invoked when all active snapshot listeners synchronize.',
  featureKeys: ['addSnapshotsInSyncListener'],
});
