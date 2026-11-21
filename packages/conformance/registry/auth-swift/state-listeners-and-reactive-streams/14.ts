import { row } from './section.ts';

export default row({
  order: 10,
  flipped: 'oracle-backed',
  api: 'Auth.currentUser',
  behavior: 'Returns the currently authenticated User, or nil if no user is signed in.',
  featureKeys: ['currentUser'],
  oracleObservations: [
    'auth-swift-anonymous-and-custom-token-session',
    'auth-swift-email-password-and-error-codes',
    'auth-swift-profile-token-claims-and-delete-lifecycle',
  ],
});
