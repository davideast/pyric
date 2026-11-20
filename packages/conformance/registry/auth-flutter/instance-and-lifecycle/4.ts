import { row } from './section.ts';

export default row({
  order: 40,
  api: 'PyricFirebaseAuthPlatform.registerWith({bridgeClient})',
  behavior: 'Registers PyricFirebaseAuthPlatform as the active platform interface singleton.',
  featureKeys: ['registerWith'],
  flipped: 'unit-backed',
});
