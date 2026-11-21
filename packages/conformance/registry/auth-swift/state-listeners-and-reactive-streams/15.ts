import { row } from './section.ts';

export default row({
  order: 20,
  flipped: 'oracle-backed',
  api: 'Auth.addStateDidChangeListener(_:)',
  behavior: 'Attaches an auth state change listener callback that fires immediately and on state transitions.',
  featureKeys: ['onAuthStateChanged'],
  oracleObservations: ['auth-swift-instance-linking-reauth-and-oauth-credentials'],
});
