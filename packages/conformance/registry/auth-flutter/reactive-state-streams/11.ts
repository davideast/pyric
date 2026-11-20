import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FirebaseAuthPlatform.authStateChanges()',
  behavior: 'Broadcast Stream emitting UserPlatform upon sign-in/sign-out with immediate replay of current state.',
  featureKeys: ['authStateChanges'],
  flipped: 'unit-backed',
});
