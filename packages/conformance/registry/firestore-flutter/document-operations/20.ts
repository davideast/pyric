import { row } from './section.ts';

export default row({
  order: 70,
  api: 'DocumentReferencePlatform.snapshots(options)',
  behavior: 'Returns a broadcast Stream emitting DocumentSnapshotPlatform on document changes.',
  featureKeys: ['snapshots'],
  flipped: 'unit-backed',
});
