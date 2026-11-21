import { row } from './section.ts';

export default row({
  order: 90,
  flipped: 'oracle-backed',
  api: 'User.providerData',
  behavior: 'Returns an array of UserInfo objects representing linked authentication providers.',
  featureKeys: ['providerData'],
  oracleObservations: ['auth-swift-instance-linking-reauth-and-oauth-credentials'],
});
