import { row } from './section.ts';

export default row({
  order: 20,
  api: 'DocumentSnapshot.getData()',
  behavior: 'Returns revived Map<String, Object> containing document field data.',
  featureKeys: ['getData'],
  flipped: 'unit-backed',
});
