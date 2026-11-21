import { row } from './section.ts';

export default row({
  order: 30,
  flipped: 'oracle-backed',
  api: 'User.displayName',
  behavior: 'Returns the user\'s display name if set.',
  featureKeys: ['displayName'],
  oracleObservations: ['auth-swift-profile-token-claims-and-delete-lifecycle'],
});
