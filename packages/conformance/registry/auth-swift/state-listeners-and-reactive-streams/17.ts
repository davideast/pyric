import { row } from './section.ts';

export default row({
  order: 40,
  flipped: 'live-host',
  api: 'Auth.addIDTokenDidChangeListener(_:)',
  behavior: 'Attaches an ID token listener callback that fires immediately and on token refreshes or user transitions.',
  featureKeys: ['onIdTokenChanged'],
});
