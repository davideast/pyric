import { row } from './section.ts';

export default row({
  order: 50,
  api: 'FirebaseAuth.clearInstancesForTest()',
  behavior: 'Clears cached FirebaseAuth instances to isolate test runs.',
  featureKeys: ['clearInstancesForTest'],
  flipped: 'unit-backed',
});
