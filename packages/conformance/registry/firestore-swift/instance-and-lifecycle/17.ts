import { row } from './section.ts';

export default row({
  order: 170,
  api: 'Firestore.terminate()',
  behavior: 'Terminates the client instance and cancels active snapshot listeners.',
  featureKeys: ['terminate'],
  flipped: 'unit-backed',
});
