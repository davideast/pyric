import { row } from './section.ts';

export default row({
  order: 10,
  flipped: 'oracle-backed',
  api: 'Auth.auth()',
  behavior: 'Returns the default Auth instance configured with the default FirebaseApp.',
  featureKeys: ['auth'],
  oracleObservations: ['auth-swift-instance-linking-reauth-and-oauth-credentials'],
});
