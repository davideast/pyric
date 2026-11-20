import { row } from './section.ts';

export default row({
  order: 70,
  api: 'OAuthProvider(providerId).credential({idToken, accessToken, rawNonce})',
  behavior: 'Constructs a generic OAuthCredential with custom providerId, idToken, accessToken, and rawNonce.',
  featureKeys: ['OAuthProvider', 'credential'],
  flipped: 'unit-backed',
});
