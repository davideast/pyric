import { row } from './section.ts';

export default row({
  order: 30,
  flipped: 'oracle-backed',
  api: 'Auth.signIn(with:)',
  behavior: 'Authenticates a user with an AuthCredential asynchronously via bridge auth.signInWithCredential RPC, returning AuthDataResult and updating currentUser.',
  featureKeys: ['signInWithCredential'],
  oracleObservations: ['auth-swift-instance-linking-reauth-and-oauth-credentials'],
});
