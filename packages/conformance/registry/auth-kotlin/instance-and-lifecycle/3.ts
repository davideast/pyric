import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FirebaseAuth.app',
  behavior: 'Returns the FirebaseApp instance associated with this FirebaseAuth instance.',
  featureKeys: ['app'],
  flipped: 'oracle-backed',
  oracleObservations: [
    'auth-kotlin-instance-linking-reauth-and-oauth-credentials',
  ],
});
