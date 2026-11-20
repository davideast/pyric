import { row } from './section.ts';

export default row({
  order: 20,
  api: 'OAuthProvider.getCredential(providerId, idToken, accessToken)',
  behavior: 'Creates an OAuthCredential for a generic OAuth provider (e.g. "apple.com", "github.com") encapsulating providerId, idToken, accessToken, and rawNonce.',
  featureKeys: ['OAuthProvider', 'getCredential'],
  flipped: 'unit-backed',
});
