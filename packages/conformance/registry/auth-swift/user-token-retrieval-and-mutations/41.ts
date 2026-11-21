import { row } from './section.ts';

export default row({
  order: 60,
  flipped: 'oracle-backed',
  api: 'User.reload()',
  behavior: 'Refreshes user account data and custom claims from the Pyric backend asynchronously.',
  featureKeys: ['reload'],
  oracleObservations: ['auth-swift-profile-token-claims-and-delete-lifecycle'],
});
