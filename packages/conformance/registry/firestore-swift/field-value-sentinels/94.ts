import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FieldValue.increment(_:)',
  behavior: 'Operand atomically incrementing numeric integer or double field value.',
  featureKeys: ['increment'],
  flipped: 'unit-backed',
});
