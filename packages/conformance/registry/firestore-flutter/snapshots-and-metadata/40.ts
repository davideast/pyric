import { row } from './section.ts';

export default row({
  order: 20,
  api: 'DocumentSnapshotPlatform.data()',
  behavior: 'Returns revived Map<String, dynamic> containing document field data.',
  featureKeys: ['data'],
  flipped: 'unit-backed',
});
