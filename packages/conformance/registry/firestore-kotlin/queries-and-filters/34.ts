import { row } from './section.ts';

export default row({
  order: 140,
  api: 'Query.startAt(documentSnapshot) / endAt(documentSnapshot)',
  behavior: 'Positions query pagination cursors using DocumentSnapshot instances.',
  featureKeys: ['startAt', 'endAt'],
  flipped: 'unit-backed',
});
