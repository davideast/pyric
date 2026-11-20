import { row } from './section.ts';

export default row({
  order: 80,
  api: 'FirebaseAuthPlatform.signInWithCredential(credential)',
  behavior: 'Authenticates user with an OAuthCredential via bridge auth.signInWithCredential RPC, updating currentUser and providerData.',
  featureKeys: ['signInWithCredential'],
  flipped: 'unit-backed',
});
