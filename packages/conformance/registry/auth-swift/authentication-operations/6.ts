import { row } from './section.ts';

export default row({
  order: 10,
  flipped: 'oracle-backed',
  api: 'Auth.signIn(withEmail:password:)',
  behavior: 'Authenticates a user with email and password asynchronously, returning AuthDataResult.',
  featureKeys: ['signInWithEmailAndPassword'],
  oracleObservations: [
    'auth-swift-email-password-and-error-codes',
    'auth-swift-profile-token-claims-and-delete-lifecycle',
    'auth-swift-instance-linking-reauth-and-oauth-credentials',
  ],
});
