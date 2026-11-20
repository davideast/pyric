import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FirebaseAuth.signInWithCredential(credential)',
  behavior: 'Authenticates a user with an OAuth/Google AuthCredential via bridge auth.signInWithCredential RPC, updating currentUser, providerData, and AuthLens.',
  featureKeys: ['signInWithCredential'],
  flipped: 'live-host',
});
