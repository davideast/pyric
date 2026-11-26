import { row } from './section.ts';

export default row({
  order: 25,
  featureKeys: ['onRegistered'],
  api: 'onRegistered(messaging, nextOrObserver): Unsubscribe (sw)',
  behavior:
    'Subscribes in `firebase/messaging/sw` to receive the active FID when the installation registers or refreshes its push subscription; supports both callback and `Observer<string>` forms with single-slot replacement semantics.',
  evidence:
    'Upstream implementation (`@firebase/messaging/sw` 0.13.3 `onRegistered`); unit-tested across in-page and SharedWorker service-worker mirrors.',
  tests: [
    'packages/pyric/test/messaging/registration.test.ts',
    'packages/cli/test/serve/worker/messaging-registration.test.ts',
  ],
});
