import { row } from './section.ts';

export default row({
  order: 40,
  api: 'FieldValue.arrayUnion(elements)',
  behavior: 'Encodes transformation adding elements to array field if absent.',
  featureKeys: ['arrayUnion'],
  flipped: 'unit-backed',
});
