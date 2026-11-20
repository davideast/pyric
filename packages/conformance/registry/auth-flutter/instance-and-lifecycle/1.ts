import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FirebaseAuthPlatform.instance',
  behavior: 'Returns the default platform instance registered via PlatformInterface.',
  featureKeys: ['instance'],
  flipped: 'unit-backed',
});
