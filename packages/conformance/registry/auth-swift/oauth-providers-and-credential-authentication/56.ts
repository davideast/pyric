import { row } from './section.ts';

export default row({
  order: 20,
  flipped: 'live-host',
  api: 'OAuthProvider.credential(withProviderID:idToken:rawNonce:accessToken:)',
  behavior: 'Constructs an OAuthCredential for arbitrary OAuth providers (e.g. "apple.com", "github.com") with ID token, access token, and optional raw nonce.',
  featureKeys: ['OAuthProvider', 'credential'],
});
