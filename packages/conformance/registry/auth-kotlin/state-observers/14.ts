import { row } from './section.ts';

export default row({
  order: 40,
  api: 'FirebaseAuth.addIdTokenListener(listener)',
  behavior: 'Registers an IdTokenListener invoked immediately on registration and whenever token or claims change.',
  featureKeys: ['addIdTokenListener', 'removeIdTokenListener'],
  flipped: 'oracle-backed',
  oracleObservations: ['auth-kotlin-profile-reload-and-listeners'],
});
