import { row } from './section.ts';

export default row({
  order: 50,
  flipped: 'unit-backed',
  api: 'Auth.removeIDTokenDidChangeListener(_:)',
  behavior: 'Detaches an ID token change listener using its registration handle.',
  featureKeys: ['onIdTokenChanged'],
});
