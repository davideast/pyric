import { row } from './section.ts';

export default row({
  order: 40,
  flipped: 'oracle-backed',
  api: 'AuthTokenResult.claims',
  behavior: 'Returns the decoded token claims dictionary.',
  featureKeys: ['authTokenResultClaims'],
  oracleObservations: [
    'auth-swift-anonymous-and-custom-token-session',
    'auth-swift-profile-token-claims-and-delete-lifecycle',
  ],
});
