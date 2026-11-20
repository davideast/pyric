import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FieldValue.serverTimestamp()',
  behavior: 'Encodes sentinel replaced by server commit timestamp during write.',
  featureKeys: ['serverTimestamp'],
  flipped: 'unit-backed',
});
