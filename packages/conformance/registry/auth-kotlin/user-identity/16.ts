import { row } from './section.ts';

export default row({
  order: 20,
  api: 'FirebaseUser.email',
  behavior: 'Returns the primary email address for the user, or null for anonymous users.',
  featureKeys: ['email'],
  flipped: 'oracle-backed',
  oracleObservations: ['auth-kotlin-email-password-lifecycle'],
});
