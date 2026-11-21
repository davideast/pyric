import { row } from './section.ts';

export default row({
  order: 20,
  flipped: 'oracle-backed',
  api: 'User.email',
  behavior: 'Returns the user\'s primary email address if available.',
  featureKeys: ['email'],
  oracleObservations: [
    'auth-swift-email-password-and-error-codes',
    'auth-swift-instance-linking-reauth-and-oauth-credentials',
  ],
});
