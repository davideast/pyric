import { row } from './section.ts';

export default row({
  order: 80,
  flipped: 'unit-backed',
  api: 'Auth.authStateChanges',
  behavior: 'Exposes an AsyncSequence for modern async/await iteration over auth state transitions.',
  featureKeys: ['authStateChanges'],
});
