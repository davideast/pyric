import { row } from './section.ts';

export default row({
  order: 150,
  api: 'QueryPlatform.get(options)',
  behavior: 'Executes query and returns QuerySnapshotPlatform containing matched documents.',
  featureKeys: ['get'],
  flipped: 'unit-backed',
});
