import { row } from './section.ts';

export default row({
  order: 50,
  api: 'FieldValue.arrayRemove(_:)',
  behavior: 'Transformation removing matching elements from array field.',
  featureKeys: ['arrayRemove'],
  flipped: 'unit-backed',
});
