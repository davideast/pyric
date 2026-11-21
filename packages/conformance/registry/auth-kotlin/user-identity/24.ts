import { row } from './section.ts';

export default row({
  order: 100,
  api: 'FirebaseUser.customClaims',
  behavior: 'Returns a map of custom claims associated with the user and carried into AuthLens.',
  featureKeys: ['customClaims'],
  flipped: 'oracle-backed',
  oracleObservations: ['auth-kotlin-anonymous-and-custom-token-session'],
});
