import { row } from './section.ts';

export default row({
  order: 60,
  api: 'DataSnapshot.child(path)',
  behavior: 'Returns a DataSnapshot for the relative descendant path within the snapshot.',
  featureKeys: ['snapshotChild'],
});
