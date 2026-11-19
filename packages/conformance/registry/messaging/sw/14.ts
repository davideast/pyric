import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["onBackgroundMessage"],
  flipped: 'oracle-backed',
  api: 'onBackgroundMessage(messaging, nextOrObserver): Unsubscribe',
  behavior:
    'Called when a message arrives while the app has no visible window client. Production routes background deliveries here rather than to `onMessage`; the delivered payload carries `data` / `from` / `messageId` and, for notification messages, a `notification` block. A DATA-ONLY message still fires `onBackgroundMessage` with no `notification` key, and a registered handler suppresses the SDK auto-display.',
  evidence:
    'oracle: `messaging-web-onbackgroundmessage.json` (no visible client → onBackgroundMessage) + `messaging-web-visibility-routing.json` + `messaging-web-data-only-background.json` (data-only fires, no notification key). Replayed by the conformance suite and by a real module Service Worker connected to the canonical SharedWorker broker in `messaging-app-boundary.pw.ts`.',
  observations: ['messaging-web-onbackgroundmessage', 'messaging-web-visibility-routing', 'messaging-web-data-only-background'],
  tests: ['packages/cli/test/e2e/messaging-app-boundary.pw.ts'],
});
