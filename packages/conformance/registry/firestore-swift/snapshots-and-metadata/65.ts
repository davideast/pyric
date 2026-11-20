import { row } from './section.ts';

export default row({
  order: 20,
  api: 'DocumentSnapshot.documentID',
  behavior: 'Unique key string identifying the snapshot document.',
  featureKeys: ['snapshotDocumentID'],
  flipped: 'unit-backed',
});
