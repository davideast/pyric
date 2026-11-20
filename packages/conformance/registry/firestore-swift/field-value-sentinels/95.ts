import { row } from './section.ts';

export default row({
  order: 40,
  api: 'FieldValue.arrayUnion(_:)',
  behavior: 'Transformation adding unique elements to array field if absent.',
  featureKeys: ['arrayUnion'],
  flipped: 'unit-backed',
});
