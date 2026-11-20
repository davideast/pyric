import { row } from './section.ts';

export default row({
  order: 60,
  api: 'GoogleAuthProvider.credential({idToken, accessToken})',
  behavior: 'Constructs an OAuthCredential for google.com with idToken and accessToken.',
  featureKeys: ['GoogleAuthProvider', 'credential'],
  flipped: 'unit-backed',
});
