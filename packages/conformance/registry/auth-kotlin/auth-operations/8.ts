import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FirebaseAuth.signInAnonymously()',
  behavior: 'Authenticates an anonymous user via bridge auth.signInAnonymously, establishing an anonymous FirebaseUser session.',
  featureKeys: ['signInAnonymously'],
  flipped: 'oracle-backed',
  oracleObservations: ['auth-kotlin-anonymous-and-custom-token-session'],
});
