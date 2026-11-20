import { row } from './section.ts';

export default row({
  order: 10,
  api: 'GoogleAuthProvider.getCredential(idToken, accessToken)',
  behavior: 'Creates an AuthCredential for Google Sign-In ("google.com") encapsulating the ID token and/or access token.',
  featureKeys: ['GoogleAuthProvider', 'getCredential'],
  flipped: 'unit-backed',
});
