import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["Notification"],
  flipped: 'oracle-backed',
  api: 'interface WebpushNotification { title?; actions?; badge?; body?; dir?; icon?; image?; renotify?; requireInteraction?; silent?; tag?; vibrate?; [key] }',
  behavior: 'Web Notification API-shaped options, including an open-ended index signature.',
  evidence: 'oracle: `messaging-send-webpush-notification-options.json` (Web Notification fields + custom index keys accepted; non-string `webpush.data` rejected). Replayed by the conformance suite.',
  observations: ['messaging-send-webpush-notification-options'],
});
