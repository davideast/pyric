import { row } from './section.ts';

export default row({
  order: 90,
  flipped: 'oracle-backed',
  api: 'Auth.idTokenChanges',
  behavior: 'Exposes an AsyncSequence for modern async/await iteration over ID token transitions.',
  featureKeys: ['idTokenChanges'],
  oracleObservations: ['auth-swift-instance-linking-reauth-and-oauth-credentials'],
});
