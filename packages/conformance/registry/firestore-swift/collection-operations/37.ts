import { row } from './section.ts';

export default row({
  order: 30,
  api: 'CollectionReference.parent',
  behavior: 'Returns parent DocumentReference or nil if this is a root collection.',
  featureKeys: ['parent'],
  flipped: 'unit-backed',
});
