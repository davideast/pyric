import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FirebaseAuthPlatform.useAuthEmulator(host, port)',
  behavior: 'Directs client auth operations to designated host and port emulator endpoint.',
  featureKeys: ['useAuthEmulator'],
  flipped: 'unit-backed',
});
