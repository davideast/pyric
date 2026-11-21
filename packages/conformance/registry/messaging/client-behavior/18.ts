import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ['onMessage', 'onBackgroundMessage'],
  api: 'Multi-tab delivery routing (several window clients, one shared service worker)',
  behavior:
    'When several window clients (browser tabs) of one origin share a single service-worker registration, `@firebase/messaging` (`onPush` over `clients.matchAll({ type: "window", includeUncontrolled: true })`) routes to the foreground plane whenever at least one non-`chrome-extension://` window client reports `visibilityState === "visible"`, posting `push-received` to every matched same-origin window client so `onMessage` fires across open tabs while `onBackgroundMessage` stays silent. When all app tabs are `hidden`, the one shared service worker receives the message once through `onBackgroundMessage` (not per tab). Clicking a notification with a same-origin link focuses a single existing client rather than opening a duplicate window.',
  evidence:
    'Staged `sdk-probes` probe `packages/conformance/probes/messaging/messaging-web-multi-tab-routing.ts` (`pendingRowLink: true`) plus dual-plane replay in `packages/conformance/test/src/messaging-multi-tab-routing-probe.test.ts` and `packages/cli/test/serve/worker/oracle-captures/messaging-client-sw.test.ts`; awaiting automated main-branch observation capture before flipping.',
  riskReasons: [
    'Multi-tab `sdk-probes` probe `messaging-web-multi-tab-routing` is staged (`pendingRowLink: true`); observation file not yet committed under `packages/conformance/observations/messaging/`.',
  ],
  notes:
    'Staged for automated `sdk-probes` capture on `main`: once `messaging-web-multi-tab-routing.json` lands, link `observations` and drop `pendingRowLink`.',
});
