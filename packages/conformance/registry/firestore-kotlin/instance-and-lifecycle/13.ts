import { row } from './section.ts';

export default row({
  order: 130,
  api: 'FirebaseFirestore.addSnapshotsInSyncListener(runnable)',
  behavior: 'Notifies when all active snapshot listeners are in sync with server state.',
  featureKeys: ['snapshotsInSync'],
});
