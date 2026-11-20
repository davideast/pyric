import { row } from './section.ts';

export default row({
  order: 20,
  api: 'FirebaseAuth.idTokenFlow()',
  behavior: 'Exposes a Coroutine Flow emitting the active FirebaseUser on token refresh, user change, or claims update.',
  featureKeys: ['idTokenFlow'],
  flipped: 'unit-backed',
});
