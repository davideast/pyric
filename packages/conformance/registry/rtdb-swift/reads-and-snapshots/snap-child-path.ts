import { row } from './section.ts';

export default row({
  order: 60,
  api: 'DataSnapshot.childSnapshot(forPath:)',
  behavior: 'Returns a DataSnapshot for the relative descendant path within the snapshot.',
  featureKeys: ['childSnapshot'],
});
