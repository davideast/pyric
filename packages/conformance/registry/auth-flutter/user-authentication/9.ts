import { row } from './section.ts';

export default row({
  order: 40,
  api: 'FirebaseAuthPlatform.signOut()',
  behavior: 'Signs out active session via bridge auth.signOut RPC, clearing currentUser and emitting null on streams.',
  featureKeys: ['signOut'],
  flipped: 'unit-backed',
});
