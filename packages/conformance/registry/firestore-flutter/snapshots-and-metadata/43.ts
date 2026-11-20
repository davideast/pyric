import { row } from './section.ts';

export default row({
  order: 50,
  api: 'QuerySnapshotPlatform.docs',
  behavior: 'Provides ordered List<DocumentSnapshotPlatform> of all query result documents.',
  featureKeys: ['docs'],
  flipped: 'unit-backed',
});
