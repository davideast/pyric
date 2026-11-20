import { row } from './section.ts';

export default row({
  order: 20,
  api: 'FirebaseAuth.createUserWithEmailAndPassword(email, password)',
  behavior: 'Creates a new user account with email and password via bridge auth.createUser, updating currentUser and AuthLens.',
  featureKeys: ['createUserWithEmailAndPassword'],
  flipped: 'live-host',
});
