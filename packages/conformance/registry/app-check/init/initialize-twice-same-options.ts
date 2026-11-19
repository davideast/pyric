import { row } from './section.ts';

export default row({
  order: 20,
  flipped: 'oracle-backed',
  api: 'initializeAppCheck(app, options) called twice',
  featureKeys: ['initializeAppCheck'],
  behavior: 'A second call with the same options returns the same instance without throwing, including when the provider is a new `CustomProvider` instance built from the same factory.',
  evidence: 'capture `app-check-client-initialize-twice` (`sameOptions`, `sameOptionsNewProviderInstance`).',
  observations: ['app-check-client-initialize-twice'],
});
