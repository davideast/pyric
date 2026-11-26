import { row } from './section.ts';

export default row({
  order: 48,
  featureKeys: ['onUnregistered'],
  api: 'onUnregistered(messaging, nextOrObserver): Unsubscribe',
  behavior:
    'Subscribes a single-slot callback or `Observer<string>` on the `Messaging` instance to receive the unregistered FID when `unregister()` completes or when `deleteToken()` revokes a stored FID registration; replacing the handler supersedes the prior callback and `Unsubscribe` clears only the matching handler.',
  evidence:
    'Upstream implementation (`@firebase/messaging` 0.13.3 `onUnregistered` / `revokeFidRegistrationIfStored`); unit-tested across in-page and SharedWorker planes.',
  tests: [
    'packages/pyric/test/messaging/registration.test.ts',
    'packages/cli/test/serve/worker/messaging-registration.test.ts',
  ],
});
