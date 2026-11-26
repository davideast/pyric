import { row } from './section.ts';

export default row({
  order: 26,
  featureKeys: ['onUnregistered'],
  api: 'onUnregistered(messaging, nextOrObserver): Unsubscribe (sw)',
  behavior:
    'Subscribes in `firebase/messaging/sw` to receive the unregistered FID when the installation unregisters from FCM; supports both callback and `Observer<string>` forms with single-slot replacement semantics.',
  evidence:
    'Upstream implementation (`@firebase/messaging/sw` 0.13.3 `onUnregistered`); unit-tested across in-page and SharedWorker service-worker mirrors.',
  tests: [
    'packages/pyric/test/messaging/registration.test.ts',
    'packages/cli/test/serve/worker/messaging-registration.test.ts',
  ],
});
