import { row } from './section.ts';

export default row({
  order: 10,
  flipped: 'live-host',
  api: 'Auth.signIn(withEmail:password:)',
  behavior: 'Authenticates a user with email and password asynchronously, returning AuthDataResult.',
  featureKeys: ['signInWithEmailAndPassword'],
});
