import { row } from './section.ts';

export default row({
  order: 70,
  flipped: 'oracle-backed',
  api: 'Auth.signOut()',
  behavior: 'Signs out the current user, clears currentUser, and notifies all state listeners.',
  featureKeys: ['signOut'],
  oracleObservations: [
    'auth-swift-anonymous-and-custom-token-session',
    'auth-swift-email-password-and-error-codes',
    'auth-swift-instance-linking-reauth-and-oauth-credentials',
  ],
});
