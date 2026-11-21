import { row } from './section.ts';

export default row({
  order: 80,
  flipped: 'oracle-backed',
  api: 'User.providerID',
  behavior: 'Returns the provider identifier for the user identity.',
  featureKeys: ['providerId'],
  oracleObservations: ['auth-swift-instance-linking-reauth-and-oauth-credentials'],
});
