import { row } from './section.ts';

export default row({
  order: 40,
  api: 'DataSnapshot.value',
  behavior: 'Returns the deserialized Dart value (Map, List, String, num, bool, or null) of the snapshot.',
  featureKeys: ['snapshotValue'],
});
