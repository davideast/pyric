import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: ["onMessage"],
  flipped: 'oracle-backed',
  api: 'interface MessagePayload { notification?; data?; fcmOptions?; from; collapseKey; messageId }',
  behavior:
    'Received message envelope delivered to `onMessage` / `onBackgroundMessage`. Production deliveries carry top-level keys `data`, `from`, `messageId`, and `notification`; `from` equals the project messaging sender id and `messageId` is present. (`from`, `collapseKey`, `messageId` are typed as required.)',
  evidence:
    'oracle: `messaging-web-onmessage-foreground.json` + `messaging-web-onbackgroundmessage.json` (top-level keys data/from/messageId/notification; from = sender id; messageId present). Replayed by the conformance suite.',
  observations: ['messaging-web-onmessage-foreground', 'messaging-web-onbackgroundmessage'],
});
