import { row } from './section.ts';

export default row({
  order: 10,
  flipped: 'oracle-backed',
  api: 'User.uid',
  behavior: 'Returns the unique string identifier for the user account.',
  featureKeys: ['uid'],
  oracleObservations: [
    'auth-swift-anonymous-and-custom-token-session',
    'auth-swift-email-password-and-error-codes',
    'auth-swift-profile-token-claims-and-delete-lifecycle',
    'auth-swift-instance-linking-reauth-and-oauth-credentials',
  ],
});
