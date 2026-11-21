import { row } from './section.ts';

export default row({
  order: 20,
  flipped: 'oracle-backed',
  api: 'Auth.auth(app:)',
  behavior: 'Returns an Auth instance associated with the specified FirebaseApp.',
  featureKeys: ['authApp'],
  oracleObservations: [
    'auth-swift-anonymous-and-custom-token-session',
    'auth-swift-email-password-and-error-codes',
    'auth-swift-profile-token-claims-and-delete-lifecycle',
    'auth-swift-instance-linking-reauth-and-oauth-credentials',
  ],
});
