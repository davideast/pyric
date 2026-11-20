import { row } from './section.ts';

export default row({
  order: 50,
  flipped: 'live-host',
  api: 'Auth.useEmulator(withHost:port:)',
  behavior: 'Configures the Auth client to connect to local Pyric emulator WebSocket endpoint.',
  featureKeys: ['useEmulator'],
});
