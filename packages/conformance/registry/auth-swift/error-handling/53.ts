import { row } from './section.ts';

export default row({
  order: 10,
  flipped: 'oracle-backed',
  api: 'AuthErrorCode',
  behavior: 'Enumerates standard Firebase Auth error codes (e.g. invalidEmail, wrongPassword, userNotFound).',
  featureKeys: ['authErrorCode'],
  oracleObservations: [
    'auth-swift-anonymous-and-custom-token-session',
    'auth-swift-email-password-and-error-codes',
    'auth-swift-profile-token-claims-and-delete-lifecycle',
    'auth-swift-instance-linking-reauth-and-oauth-credentials',
  ],
});
