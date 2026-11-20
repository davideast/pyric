import { row } from './section.ts';

export default row({
  order: 30,
  api: 'DataSnapshot.key',
  behavior: 'Returns the key name of the location that generated the DataSnapshot.',
  featureKeys: ['snapshotKey'],
});
