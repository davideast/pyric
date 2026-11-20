import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FirebaseAuth.authStateFlow()',
  behavior: 'Exposes a Coroutine StateFlow emitting the active FirebaseUser on sign-in, sign-out, or user change.',
  featureKeys: ['authStateFlow'],
  flipped: 'unit-backed',
});
