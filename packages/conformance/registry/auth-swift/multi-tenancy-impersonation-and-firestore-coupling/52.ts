import { row } from './section.ts';

export default row({
  order: 50,
  flipped: 'live-host',
  api: 'SnapshotSubscriptionCoordinator re-subscription',
  behavior: 'Auth state and token transitions trigger Firestore snapshot listener re-subscription.',
  featureKeys: ['authFirestoreCoupling'],
});
