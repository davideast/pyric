import { row } from './section.ts';

export default row({
  order: 160,
  api: 'QueryPlatform.snapshots(options)',
  behavior: 'Returns broadcast stream emitting QuerySnapshotPlatform upon matching changes.',
  featureKeys: ['snapshots'],
  flipped: 'unit-backed',
});
