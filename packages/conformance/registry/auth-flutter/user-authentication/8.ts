import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FirebaseAuthPlatform.signInAnonymously()',
  behavior: 'Creates an anonymous session via bridge auth.signInAnonymously RPC.',
  featureKeys: ['signInAnonymously'],
  flipped: 'unit-backed',
});
