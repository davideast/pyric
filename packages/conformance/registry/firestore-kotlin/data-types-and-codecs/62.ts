import { row } from './section.ts';

export default row({
  order: 40,
  api: 'DocumentReference codec',
  behavior: 'Encodes and decodes DocumentReference values stored within document fields.',
  featureKeys: ['DocumentReference'],
  flipped: 'unit-backed',
});
