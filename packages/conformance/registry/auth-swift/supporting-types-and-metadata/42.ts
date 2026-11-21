import { row } from './section.ts';

export default row({
  order: 10,
  flipped: 'oracle-backed',
  api: 'AuthDataResult.user',
  behavior: 'Returns the User instance associated with the authentication result.',
  featureKeys: ['authDataResult'],
  oracleObservations: [
    'auth-swift-anonymous-and-custom-token-session',
    'auth-swift-email-password-and-error-codes',
    'auth-swift-profile-token-claims-and-delete-lifecycle',
    'auth-swift-instance-linking-reauth-and-oauth-credentials',
  ],
});
