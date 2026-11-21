import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ['getToken', 'deleteToken'],
  api: 'Registration-token rotation and refresh over the app lifecycle',
  behavior:
    'A registration token is stable within a session (row messaging#2 pins that repeated `getToken` calls on one service-worker registration return the same token) but is not permanent across the app lifecycle: `@firebase/messaging` rotates it when the underlying `PushSubscription` (`endpoint`, `p256dh`, `auth`), `vapidKey`, or registration is invalidated, revoking the prior token on `fcmregistrations.googleapis.com` and minting a replacement. The modular web SDK exports no `onTokenRefresh` callback, so an app observes a new token only by calling `getToken` again, and a rotated-away prior token eventually answers `404 NOT_FOUND` (`UNREGISTERED`) on the send plane.',
  evidence:
    'Upstream `@firebase/messaging` 0.13.3 (`getTokenInternal` / `isTokenValid`) and local broker parity (`packages/conformance/test/src/messaging-web-lifecycle-scenarios.test.ts`); live PushSubscription rotation scenario wired in `packages/conformance/src/capture/messaging-web/lifecycle-scenarios.ts` (`messaging-web-token-rotation`), awaiting a `human-witnessed` headed Chromium run.',
  riskReasons: [
    'Live Web Push subscription rotation and subsequent send-plane `UNREGISTERED` propagation require the headed `human-witnessed` `messaging-web` rig; `messaging-web-token-rotation.json` is not yet committed.',
  ],
  notes:
    'Remains `unverified` until a headed `messaging-web` capture (`--write --only multi-device-fanout,token-rotation`) commits `messaging-web-token-rotation.json`.',
});
