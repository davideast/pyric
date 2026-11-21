import { row } from './section.ts';

export default row({
  order: 30,
  flipped: 'oracle-backed',
  api: 'AuthTokenResult.token',
  behavior: 'Returns the JWT token string.',
  featureKeys: ['authTokenResultToken'],
  oracleObservations: ['auth-swift-profile-token-claims-and-delete-lifecycle'],
});
