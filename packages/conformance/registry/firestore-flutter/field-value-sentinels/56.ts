import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FieldValuePlatform.increment(value)',
  behavior: 'Encodes numeric transformation operand that atomically increments field value.',
  featureKeys: ['increment'],
  flipped: 'unit-backed',
});
