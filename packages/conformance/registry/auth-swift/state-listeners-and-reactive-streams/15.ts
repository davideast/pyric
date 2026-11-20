import { row } from './section.ts';

export default row({
  order: 20,
  flipped: 'unit-backed',
  api: 'Auth.addStateDidChangeListener(_:)',
  behavior: 'Attaches an auth state change listener callback that fires immediately and on state transitions.',
  featureKeys: ['onAuthStateChanged'],
});
