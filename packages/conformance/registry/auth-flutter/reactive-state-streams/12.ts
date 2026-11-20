import { row } from './section.ts';

export default row({
  order: 20,
  api: 'FirebaseAuthPlatform.idTokenChanges()',
  behavior: 'Broadcast Stream emitting UserPlatform upon sign-in, sign-out, or token refresh with immediate replay.',
  featureKeys: ['idTokenChanges'],
  flipped: 'unit-backed',
});
