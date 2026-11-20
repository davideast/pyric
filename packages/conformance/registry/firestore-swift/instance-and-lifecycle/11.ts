import { row } from './section.ts';

export default row({
  order: 110,
  api: 'Firestore.runTransaction(_:)',
  behavior: 'Executes an interactive transaction block with automatic conflict retry.',
  featureKeys: ['runTransaction'],
  flipped: 'unit-backed',
});
