import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["onMessage"],
  flipped: 'oracle-backed',
  api: 'onMessage(messaging, nextOrObserver): Unsubscribe',
  behavior:
    'Dispatched with the push payload when a message arrives while a window client is visible; the returned function stops listening. Routing keys on page VISIBILITY, not focus: a `visibilityState: "visible"` page receives `onMessage` even when unfocused, and when no window client is visible the message routes to the service-worker `onBackgroundMessage` instead.',
  evidence:
    'oracle: `messaging-web-onmessage-foreground.json` (focused page → onMessage) + `messaging-web-visibility-routing.json` (visible → onMessage, no visible client → onBackgroundMessage). Replayed by the conformance suite.',
  observations: ['messaging-web-onmessage-foreground', 'messaging-web-visibility-routing'],
});
