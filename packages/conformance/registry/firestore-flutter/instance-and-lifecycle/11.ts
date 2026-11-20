import { row } from './section.ts';

export default row({
  order: 110,
  api: 'FirebaseFirestorePlatform.terminate()',
  behavior: 'Terminates the platform client, unsubscribing all active snapshot streams.',
  featureKeys: ['terminate'],
  flipped: 'unit-backed',
});
