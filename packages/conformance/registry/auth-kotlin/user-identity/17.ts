import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FirebaseUser.displayName',
  behavior: 'Returns the display name associated with the user profile, or null if unset.',
  featureKeys: ['displayName'],
  flipped: 'oracle-backed',
  oracleObservations: ['auth-kotlin-profile-reload-and-listeners'],
});
