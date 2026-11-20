import { row } from './section.ts';

export default row({
  order: 50,
  api: 'DataSnapshot.children',
  behavior: 'Returns an iterator of child DataSnapshots ordered according to the active query.',
  featureKeys: ['children'],
});
