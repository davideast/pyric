import { row } from './section.ts';

export default row({
  order: 10,
  flipped: 'oracle-backed',
  api: 'onTokenChanged(appCheck, listener | observer): Unsubscribe',
  featureKeys: ['onTokenChanged'],
  behavior: 'Returns an unsubscribe function. A listener registered after a token exists is not called synchronously; it is called once, asynchronously, with the current cached token.',
  evidence: 'capture `app-check-client-on-token-changed` (`unsubscribeType`, `lateListenerCallsSynchronous`, `lateListenerCallsWithin500ms`, `lateListenerTokenSequence`).',
  observations: ['app-check-client-on-token-changed'],
});
