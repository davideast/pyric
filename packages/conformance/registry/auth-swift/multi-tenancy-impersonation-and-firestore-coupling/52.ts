import { row } from './section.ts';

export default row({
  order: 50,
  flipped: 'unit-backed',
  api: 'SnapshotSubscriptionCoordinator re-subscription',
  behavior: 'Auth state and token transitions trigger Firestore snapshot listener re-subscription.',
  featureKeys: ['authFirestoreCoupling'],
});
