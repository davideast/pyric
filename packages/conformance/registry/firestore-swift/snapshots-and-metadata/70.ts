import { row } from './section.ts';

export default row({
  order: 70,
  api: 'DocumentSnapshot.get(_:)',
  behavior: 'Extracts nested field value supporting dot-delimited string or FieldPath.',
  featureKeys: ['get'],
  flipped: 'unit-backed',
});
