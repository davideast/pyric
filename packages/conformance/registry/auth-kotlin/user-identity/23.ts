import { row } from './section.ts';

export default row({
  order: 90,
  api: 'FirebaseUser.providerData',
  behavior: 'Returns a list of UserInfo instances corresponding to linked provider accounts.',
  featureKeys: ['providerData'],
  flipped: 'oracle-backed',
  oracleObservations: [
    'auth-kotlin-anonymous-and-custom-token-session',
    'auth-kotlin-email-password-lifecycle',
    'auth-kotlin-instance-linking-reauth-and-oauth-credentials',
  ],
});
