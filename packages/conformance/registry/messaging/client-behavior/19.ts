import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ['getToken', 'onMessage'],
  api: 'Multi-device delivery (one app instance holding several tokens; per-token fan-out)',
  behavior:
    "A single user or app can hold several registration tokens at once - one per browser, profile, or device. A token-targeted send reaches exactly one token; a topic, condition, or multicast send fans out independently to every subscribed token, with no server-side de-duplication across a user's devices, so each device receives its own copy. Stated from the FCM targeting model; live cross-profile push fan-out capture is wired in `messaging-web` (`multi-device-fanout`) awaiting a headed browser run.",
  evidence:
    'Upstream FCM targeting model and local broker parity (`packages/conformance/test/src/messaging-web-lifecycle-scenarios.test.ts`); live two-profile browser push scenario wired in `packages/conformance/src/capture/messaging-web/lifecycle-scenarios.ts` (`messaging-web-multi-device-fanout`), awaiting a `human-witnessed` headed Chromium run.',
  riskReasons: [
    'Cross-device server-side push fan-out requires two live Web Push GCM subscriptions in the headed `human-witnessed` `messaging-web` rig; `messaging-web-multi-device-fanout.json` is not yet committed.',
  ],
  notes:
    'Remains `unverified` until a headed `messaging-web` capture (`--write --only multi-device-fanout,token-rotation`) commits `messaging-web-multi-device-fanout.json`.',
});
