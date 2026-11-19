import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["getToken"],
  flipped: 'oracle-backed',
  api: 'getToken(messaging, options?): Promise<string>',
  behavior:
    'Subscribes the instance to push and resolves with an FCM registration token; requests notification permission if not already granted and rejects if denied. Production tokens are colon-separated, URL-safe, ~142 chars, with the suffix after the colon beginning `APA91b`, and are stable across repeated `getToken` calls on the same service-worker registration (no per-call rotation).',
  evidence:
    'oracle: `messaging-web-token-shape.json` (minted, length 142, colon-separated, suffix starts `APA91b`, URL-safe) + `messaging-web-token-stability.json` (second `getToken` on the same registration returns the same token). Replayed by the conformance suite.',
  observations: ['messaging-web-token-shape', 'messaging-web-token-stability'],
});
