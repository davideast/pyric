import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["WebpushConfig"],
  flipped: 'oracle-backed',
  api: 'interface WebpushConfig { headers?; data?; notification?; fcmOptions? }',
  behavior: 'Webpush overrides. Production accepts a webpush config carrying `headers.TTL` or lowercase `headers.ttl` with non-negative integer digits plus `fcmOptions.link`; negative or non-numeric `TTL`/`ttl` values are rejected case-insensitively with an INVALID_ARGUMENT error envelope naming canonical `message.webpush.headers.TTL`.',
  evidence: 'oracle: `messaging-send-webpush-config-accepted.json` (accepted) + `messaging-send-webpush-invalid-ttl-error-envelope.json` (bad uppercase TTL rejected) + `messaging-send-webpush-lowercase-ttl.json` (lowercase `ttl` validated case-insensitively across valid, negative, and non-numeric values). Replayed by the conformance suite.',
  observations: ['messaging-send-webpush-config-accepted', 'messaging-send-webpush-invalid-ttl-error-envelope', 'messaging-send-webpush-lowercase-ttl'],
});
