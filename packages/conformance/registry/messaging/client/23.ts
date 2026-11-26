import { row } from './section.ts';

export default row({
  order: 44,
  featureKeys: ['unregister'],
  api: 'unregister(messaging): Promise<void>',
  behavior:
    'Unregisters the app instance from FCM by deleting its FID-based registration, scrubbing local FID and legacy token metadata, marking the FID `UNREGISTERED` on the send plane, notifying `onUnregistered` (if set) with the unregistered FID, and resolving `undefined`.',
  evidence:
    'Upstream implementation (`@firebase/messaging` 0.13.3 `unregister`); unit-tested across in-page and SharedWorker planes.',
  tests: [
    'packages/pyric/test/messaging/registration.test.ts',
    'packages/cli/test/serve/worker/messaging-registration.test.ts',
  ],
});
