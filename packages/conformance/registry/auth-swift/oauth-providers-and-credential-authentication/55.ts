import { row } from './section.ts';

export default row({
  order: 10,
  flipped: 'live-host',
  api: 'GoogleAuthProvider.credential(withIDToken:accessToken:)',
  behavior: 'Constructs an AuthCredential for Google Sign-In ("google.com") encapsulating ID token and access token.',
  featureKeys: ['GoogleAuthProvider', 'credential'],
});
