import { row } from './section.ts';

export default row({
  order: 30,
  flipped: 'oracle-backed',
  api: 'User.getIDTokenResult(forcingRefresh:)',
  behavior: 'Retrieves detailed AuthTokenResult with expiration and claims asynchronously.',
  featureKeys: ['getIdTokenResult'],
  oracleObservations: [
    'auth-swift-anonymous-and-custom-token-session',
    'auth-swift-profile-token-claims-and-delete-lifecycle',
  ],
});
