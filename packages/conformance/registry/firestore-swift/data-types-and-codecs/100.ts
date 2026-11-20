import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FieldPath',
  behavior: 'Path pointing to nested document field or documentID sentinel.',
  featureKeys: ['fieldPath'],
  flipped: 'unit-backed',
});
