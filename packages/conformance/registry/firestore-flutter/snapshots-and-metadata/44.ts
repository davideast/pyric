import { row } from './section.ts';

export default row({
  order: 60,
  api: 'QuerySnapshotPlatform.docChanges',
  behavior: 'Exposes List<DocumentChangePlatform> detailing added, modified, removed types and index shifts.',
  featureKeys: ['docChanges'],
  flipped: 'unit-backed',
});
