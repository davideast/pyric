import { row } from './section.ts';

export default row({
  order: 30,
  api: 'DocumentSnapshot.data(as:decoder:)',
  behavior: 'Decodes document snapshot fields directly into Decodable model.',
  featureKeys: ['dataAsDecodable'],
  flipped: 'unit-backed',
});
