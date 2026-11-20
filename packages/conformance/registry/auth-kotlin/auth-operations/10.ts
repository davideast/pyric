import { row } from './section.ts';

export default row({
  order: 50,
  api: 'FirebaseAuth.currentUser',
  behavior: 'Returns the currently signed-in FirebaseUser, or null if unauthenticated.',
  featureKeys: ['currentUser'],
  flipped: 'unit-backed',
});
