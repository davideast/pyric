import { row } from './section.ts';

export default row({
  order: 50,
  flipped: 'oracle-backed',
  api: 'AuthTokenResult.expirationTime',
  behavior: 'Returns the expiration timestamp of the ID token.',
  featureKeys: ['authTokenResultExpiration'],
  oracleObservations: ['auth-swift-profile-token-claims-and-delete-lifecycle'],
});
