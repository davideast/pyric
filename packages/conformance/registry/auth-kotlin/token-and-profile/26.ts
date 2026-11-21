import { row } from './section.ts';

export default row({
  order: 20,
  api: 'FirebaseUser.getIdTokenResult(forceRefresh)',
  behavior: 'Retrieves GetTokenResult with parsed JWT token string, claims map, expiration, and provider info.',
  featureKeys: ['getIdTokenResult'],
  flipped: 'oracle-backed',
  oracleObservations: ['auth-kotlin-anonymous-and-custom-token-session'],
});
