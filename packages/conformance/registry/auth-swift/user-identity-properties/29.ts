import { row } from './section.ts';

export default row({
  order: 50,
  flipped: 'oracle-backed',
  api: 'User.phoneNumber',
  behavior: 'Returns the user\'s phone number if available.',
  featureKeys: ['phoneNumber'],
  oracleObservations: ['auth-swift-instance-linking-reauth-and-oauth-credentials'],
});
