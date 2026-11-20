import { row } from './section.ts';

export default row({
  order: 20,
  api: 'FirebaseUser.getIdTokenResult(forceRefresh)',
  behavior: 'Retrieves GetTokenResult with parsed JWT token string, claims map, expiration, and provider info.',
  featureKeys: ['getIdTokenResult'],
  flipped: 'unit-backed',
});
