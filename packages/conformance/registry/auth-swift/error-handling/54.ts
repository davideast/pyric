import { row } from './section.ts';

export default row({
  order: 20,
  flipped: 'oracle-backed',
  api: 'AuthError',
  behavior: 'Conforms to LocalizedError and maps wire error codes to structured AuthErrorCode.',
  featureKeys: ['authError'],
  oracleObservations: [
    'auth-swift-anonymous-and-custom-token-session',
    'auth-swift-email-password-and-error-codes',
    'auth-swift-profile-token-claims-and-delete-lifecycle',
    'auth-swift-instance-linking-reauth-and-oauth-credentials',
  ],
});
