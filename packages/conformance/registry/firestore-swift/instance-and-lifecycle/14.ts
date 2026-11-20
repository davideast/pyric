import { row } from './section.ts';

export default row({
  order: 140,
  api: 'Firestore.useEmulator(host:port:)',
  behavior: 'Configures client networking to route requests to a local emulator or Pyric bridge.',
  featureKeys: ['useEmulator'],
  flipped: 'unit-backed',
});
