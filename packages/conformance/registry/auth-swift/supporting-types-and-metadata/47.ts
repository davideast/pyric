import { row } from './section.ts';

export default row({
  order: 60,
  flipped: 'oracle-backed',
  api: 'UserInfoImpl',
  behavior: 'Conforms to UserInfo protocol representing user attributes from an auth provider.',
  featureKeys: ['userInfo'],
  oracleObservations: ['auth-swift-instance-linking-reauth-and-oauth-credentials'],
});
