import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FirebaseUser.updateProfile(request)',
  behavior: 'Mutates user display name and photo URI via bridge auth.updateProfile, updating local user state.',
  featureKeys: ['updateProfile'],
  flipped: 'oracle-backed',
  oracleObservations: ['auth-kotlin-profile-reload-and-listeners'],
});
