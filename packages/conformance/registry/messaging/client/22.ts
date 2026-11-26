import { row } from './section.ts';

export default row({
  order: 42,
  featureKeys: ['register'],
  api: 'register(messaging, options?): Promise<void>',
  behavior:
    'Registers the app instance with FCM using its 22-character Firebase Installation ID (FID), delivering the FID via `onRegistered` on each call and resolving `undefined`. Rejects with `messaging/permission-blocked` when notification permission is denied, `messaging/invalid-on-registered-handler` when no `onRegistered` listener is active, and `messaging/invalid-sw-registration` for invalid `serviceWorkerRegistration` inputs; clears local legacy `getToken` metadata and activates the FID on the send plane.',
  evidence:
    'Upstream implementation (`@firebase/messaging` 0.13.3 `register` / `registerFcmRegistrationWithFid`); unit-tested across in-page and SharedWorker planes.',
  tests: [
    'packages/pyric/test/messaging/registration.test.ts',
    'packages/cli/test/serve/worker/messaging-registration.test.ts',
  ],
});
