import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FirebaseAuthException translation',
  behavior: 'Translates bridge RPC errors to typed FirebaseAuthException with normalized error codes.',
  featureKeys: ['FirebaseAuthException'],
  flipped: 'unit-backed',
});
