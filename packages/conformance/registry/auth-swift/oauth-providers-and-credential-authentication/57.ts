import { row } from './section.ts';

export default row({
  order: 30,
  flipped: 'live-host',
  api: 'Auth.signIn(with:)',
  behavior: 'Authenticates a user with an AuthCredential asynchronously via bridge auth.signInWithCredential RPC, returning AuthDataResult and updating currentUser.',
  featureKeys: ['signInWithCredential'],
});
