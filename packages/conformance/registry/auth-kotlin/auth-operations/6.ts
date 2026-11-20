import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FirebaseAuth.signInWithEmailAndPassword(email, password)',
  behavior: 'Authenticates a user with email and password via bridge auth.signInEmail, updating currentUser and AuthLens.',
  featureKeys: ['signInWithEmailAndPassword'],
  flipped: 'live-host',
});
