import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FirebaseAuthException',
  behavior: 'Translates bridge auth error codes into standard Firebase error codes (e.g. ERROR_WRONG_PASSWORD, ERROR_USER_NOT_FOUND).',
  featureKeys: ['firebaseAuthException'],
  flipped: 'oracle-backed',
  oracleObservations: [
    'auth-kotlin-anonymous-and-custom-token-session',
    'auth-kotlin-error-codes-and-exceptions',
    'auth-kotlin-instance-linking-reauth-and-oauth-credentials',
  ],
});
