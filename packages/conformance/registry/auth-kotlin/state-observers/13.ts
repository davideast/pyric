import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FirebaseAuth.addAuthStateListener(listener)',
  behavior: 'Registers an AuthStateListener invoked immediately on registration and whenever authentication state changes.',
  featureKeys: ['addAuthStateListener', 'removeAuthStateListener'],
  flipped: 'oracle-backed',
  oracleObservations: ['auth-kotlin-profile-reload-and-listeners'],
});
