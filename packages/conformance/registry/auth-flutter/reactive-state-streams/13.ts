import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FirebaseAuthPlatform.userChanges()',
  behavior: 'Broadcast Stream emitting UserPlatform upon user profile, claims, or auth transitions.',
  featureKeys: ['userChanges'],
  flipped: 'unit-backed',
});
