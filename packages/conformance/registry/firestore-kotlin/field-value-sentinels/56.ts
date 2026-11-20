import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FieldValue.increment(value)',
  behavior: 'Encodes numeric transformation operand that atomically increments field value.',
  featureKeys: ['increment'],
  flipped: 'unit-backed',
});
