import { row } from './section.ts';

export default row({
  order: 90,
  api: 'QueryDocumentSnapshot',
  behavior: 'Guaranteed-existent document snapshot subclass where data() is non-optional.',
  featureKeys: ['queryDocumentSnapshot'],
  flipped: 'unit-backed',
});
