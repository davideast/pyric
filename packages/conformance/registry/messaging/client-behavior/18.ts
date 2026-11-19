import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["onMessage", "onBackgroundMessage"],
  api: 'Multi-tab delivery routing (several window clients, one shared service worker)',
  behavior:
    'When several window clients (browser tabs) of one origin share a single service-worker registration, a foreground delivery reaches every visible tab through `onMessage`, and when no tab is visible the one shared service worker receives the message once through `onBackgroundMessage` (the worker is shared across tabs, not instantiated per tab). A notification click focuses a single existing client rather than opening a duplicate. Stated from the FCM web SDK and the Service Worker client model; no committed observation replays the multi-tab fan-out yet.',
  evidence:
    'Upstream documentation (`@firebase/messaging` 0.12.26 + W3C Service Worker `Clients` model); no observation yet. Candidate probe: open two tabs on one registration and deliver with one tab visible, then with both hidden — assert `onMessage` fires once per visible tab and `onBackgroundMessage` fires exactly once on the shared worker.',
  riskReasons: [
    'Multi-tab fan-out and shared-service-worker routing stated from FCM web SDK and Service Worker documentation only; no committed observation replays it — a probe candidate before implementation.',
  ],
  notes:
    'Candidate capture for the scheduled re-capture lane (#444): a two-tab browser rig sharing one service-worker registration, asserting per-visible-tab `onMessage` and a single shared-worker `onBackgroundMessage`.',
});
