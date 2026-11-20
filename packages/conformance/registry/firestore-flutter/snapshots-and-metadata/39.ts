import { row } from './section.ts';

export default row({
  order: 10,
  api: 'DocumentSnapshotPlatform.exists',
  behavior: 'Reports true if document is present in Firestore; false if absent.',
  featureKeys: ['exists'],
  flipped: 'unit-backed',
});
