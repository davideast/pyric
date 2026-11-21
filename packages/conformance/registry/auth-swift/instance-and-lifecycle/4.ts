import { row } from './section.ts';

export default row({
  order: 40,
  flipped: 'oracle-backed',
  api: 'Auth.app',
  behavior: 'Returns the FirebaseApp instance associated with this Auth instance.',
  featureKeys: ['app'],
  oracleObservations: ['auth-swift-instance-linking-reauth-and-oauth-credentials'],
});
