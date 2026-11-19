import { row } from './section.ts';

export default row({
  order: 90,
  featureKeys: ["MessagePayload"],
  flipped: 'oracle-backed',
  api: 'interface NotificationPayload { title?; body?; image?; icon? }',
  behavior:
    'Display-notification block inside a `MessagePayload`. Production foreground deliveries carry a `notification` object whose keys include `title` and `body`.',
  evidence:
    'oracle: `messaging-web-onmessage-foreground.json` (notificationKeys body, title). Replayed by the conformance suite.',
  observations: ['messaging-web-onmessage-foreground'],
});
