import { row } from './section.ts';

export default row({
  order: 46,
  featureKeys: ['onRegistered'],
  api: 'onRegistered(messaging, nextOrObserver): Unsubscribe',
  behavior:
    'Subscribes a single-slot callback or `Observer<string>` on the `Messaging` instance to receive the active 22-character FID when `register()` succeeds; replacing the handler supersedes the prior callback and the returned `Unsubscribe` clears only the matching handler.',
  evidence:
    'Upstream implementation (`@firebase/messaging` 0.13.3 `onRegistered`); unit-tested across in-page and SharedWorker planes.',
  tests: [
    'packages/pyric/test/messaging/registration.test.ts',
    'packages/cli/test/serve/worker/messaging-registration.test.ts',
  ],
});
