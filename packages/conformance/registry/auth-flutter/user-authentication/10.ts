import { row } from './section.ts';

export default row({
  order: 50,
  api: 'FirebaseAuthPlatform.currentUser',
  behavior: 'Accesses cached UserPlatform instance or null when unauthenticated.',
  featureKeys: ['currentUser'],
  flipped: 'unit-backed',
});
