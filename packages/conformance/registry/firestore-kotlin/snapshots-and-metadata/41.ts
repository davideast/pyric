import { row } from './section.ts';

export default row({
  order: 30,
  api: 'DocumentSnapshot.get(field)',
  behavior: 'Extracts single field value supporting dot notation or FieldPath instances.',
  featureKeys: ['get'],
  flipped: 'unit-backed',
});
