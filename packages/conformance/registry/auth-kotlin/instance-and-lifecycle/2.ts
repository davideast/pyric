import { row } from './section.ts';

export default row({
  order: 20,
  api: 'FirebaseAuth.getInstance(app) / Firebase.auth(app)',
  behavior: 'Provides isolated FirebaseAuth instances distinguished by FirebaseApp.',
  featureKeys: ['getInstance'],
  flipped: 'oracle-backed',
  oracleObservations: [
    'auth-kotlin-email-password-lifecycle',
    'auth-kotlin-profile-reload-and-listeners',
    'auth-kotlin-error-codes-and-exceptions',
    'auth-kotlin-instance-linking-reauth-and-oauth-credentials',
  ],
});
