import { row } from './section.ts';

export default row({
  order: 20,
  flipped: 'live-host',
  api: 'Auth.signIn(withEmail:password:completion:)',
  behavior: 'Authenticates a user with email and password using a completion closure.',
  featureKeys: ['signInWithEmailAndPassword'],
});
