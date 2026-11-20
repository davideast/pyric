import { row } from './section.ts';

export default row({
  order: 140,
  api: 'QueryPlatform.startAtDocument / endAtDocument',
  behavior: 'Positions query pagination cursors using DocumentSnapshotPlatform instances.',
  featureKeys: ['startAtDocument', 'endAtDocument'],
  flipped: 'unit-backed',
});
