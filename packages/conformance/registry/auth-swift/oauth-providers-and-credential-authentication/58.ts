import { row } from './section.ts';

export default row({
  order: 40,
  flipped: 'unit-backed',
  api: 'Auth.signIn(with:completion:)',
  behavior: 'Authenticates a user with an AuthCredential using a completion closure.',
  featureKeys: ['signInWithCredential'],
});
