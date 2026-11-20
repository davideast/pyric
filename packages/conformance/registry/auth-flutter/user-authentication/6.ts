import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FirebaseAuthPlatform.signInWithEmailAndPassword(email, password)',
  behavior: 'Authenticates user via bridge auth.signInEmail RPC and updates currentUser.',
  featureKeys: ['signInWithEmailAndPassword'],
  flipped: 'unit-backed',
});
