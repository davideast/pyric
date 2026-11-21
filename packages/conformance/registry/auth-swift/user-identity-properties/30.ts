import { row } from './section.ts';

export default row({
  order: 60,
  flipped: 'oracle-backed',
  api: 'User.isAnonymous',
  behavior: 'Indicates whether the user account is anonymous.',
  featureKeys: ['isAnonymous'],
  oracleObservations: [
    'auth-swift-anonymous-and-custom-token-session',
    'auth-swift-email-password-and-error-codes',
    'auth-swift-instance-linking-reauth-and-oauth-credentials',
  ],
});
