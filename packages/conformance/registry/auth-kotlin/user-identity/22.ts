import { row } from './section.ts';

export default row({
  order: 80,
  api: 'FirebaseUser.providerId',
  behavior: 'Returns the primary provider identifier ("firebase").',
  featureKeys: ['providerId'],
  flipped: 'oracle-backed',
  oracleObservations: ['auth-kotlin-anonymous-and-custom-token-session'],
});
