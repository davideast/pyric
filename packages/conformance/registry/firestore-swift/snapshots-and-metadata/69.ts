import { row } from './section.ts';

export default row({
  order: 60,
  api: 'DocumentSnapshot.data(with:)',
  behavior: 'Returns document fields configuring ServerTimestampBehavior handling.',
  featureKeys: ['dataWithServerTimestampBehavior'],
  flipped: 'unit-backed',
});
