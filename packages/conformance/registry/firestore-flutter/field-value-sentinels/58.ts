import { row } from './section.ts';

export default row({
  order: 50,
  api: 'FieldValuePlatform.arrayRemove(elements)',
  behavior: 'Encodes transformation removing matching elements from array field.',
  featureKeys: ['arrayRemove'],
  flipped: 'unit-backed',
});
