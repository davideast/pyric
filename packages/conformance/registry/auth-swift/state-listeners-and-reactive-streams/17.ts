import { row } from './section.ts';

export default row({
  order: 40,
  flipped: 'oracle-backed',
  api: 'Auth.addIDTokenDidChangeListener(_:)',
  behavior: 'Attaches an ID token listener callback that fires immediately and on token refreshes or user transitions.',
  featureKeys: ['onIdTokenChanged'],
  oracleObservations: ['auth-swift-instance-linking-reauth-and-oauth-credentials'],
});
