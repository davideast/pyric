import { row } from './section.ts';

export default row({
  order: 20,
  api: 'FirebaseAuthPlatform.createUserWithEmailAndPassword(email, password)',
  behavior: 'Registers user via bridge auth.createUser RPC and returns UserCredential with isNewUser: true.',
  featureKeys: ['createUserWithEmailAndPassword'],
  flipped: 'unit-backed',
});
