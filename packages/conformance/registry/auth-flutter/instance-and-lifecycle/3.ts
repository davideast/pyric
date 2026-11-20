import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FirebaseAuthPlatform.delegateFor(app: app)',
  behavior: 'Creates an isolated platform instance sharing the bridge client for non-default apps.',
  featureKeys: ['delegateFor'],
  flipped: 'unit-backed',
});
