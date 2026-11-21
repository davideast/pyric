import { row } from './section.ts';

export default row({
  order: 30,
  flipped: 'oracle-backed',
  api: 'Auth.createUser(withEmail:password:)',
  behavior: 'Creates a new user account with email and password asynchronously, returning AuthDataResult.',
  featureKeys: ['createUserWithEmailAndPassword'],
  oracleObservations: [
    'auth-swift-email-password-and-error-codes',
    'auth-swift-profile-token-claims-and-delete-lifecycle',
    'auth-swift-instance-linking-reauth-and-oauth-credentials',
  ],
});
