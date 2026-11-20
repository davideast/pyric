import { row } from './section.ts';

export default row({
  order: 30,
  flipped: 'live-host',
  api: 'Auth.removeStateDidChangeListener(_:)',
  behavior: 'Detaches an auth state change listener using its registration handle.',
  featureKeys: ['onAuthStateChanged'],
});
