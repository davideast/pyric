import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FieldValue.serverTimestamp()',
  behavior: 'Sentinel replaced by server commit timestamp during write processing.',
  featureKeys: ['serverTimestamp'],
  flipped: 'unit-backed',
});
