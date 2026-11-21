import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["send", "enableLegacyHttpTransport"],
  api: 'Send retry and backoff on transient transport failures',
  behavior:
    'In `firebase-admin` 13.10.0 (`lib/utils/api-request.js` `defaultRetryConfig()`), both `AuthorizedHttpClient` (HTTP/1.1) and `AuthorizedHttp2Client` (HTTP/2) retry up to `maxRetries: 4` on HTTP `503` (`statusCodes: [503]`; HTTP `500` `INTERNAL` is not retried) and low-level `ECONNRESET` / `ETIMEDOUT` I/O errors, honoring `Retry-After` headers or exponential backoff (`0ms` on first retry, then `(2 ** retryAttempts) * 0.5s` up to `60000ms`). `enableLegacyHttpTransport` switches `sendEach` and `sendEachForMulticast` from `AuthorizedHttp2Client` (`Http2SessionHandler` over `https://fcm.googleapis.com`) to `AuthorizedHttpClient` (HTTP/1.1). `pyric-admin/messaging` dispatches in-memory to `MessagingBroker` without an HTTP retry layer, and no production observation records transport retry intervals.',
  evidence:
    'Upstream `firebase-admin` 13.10.0 (`lib/messaging/messaging.js`, `lib/messaging/messaging-api-request-internal.js`, and `lib/utils/api-request.js`); no committed observation (`FCM_SEND_HOST` is hardcoded to `fcm.googleapis.com` with no emulator host override, and production FCM cannot be induced on demand to emit deterministic HTTP 503 sequences).',
  riskReasons: [
    'Send transport retry (`statusCodes: [503]`, `ECONNRESET`/`ETIMEDOUT`, `maxRetries: 4`) has no committed production observation and `pyric-admin/messaging` dispatches synchronously in-memory to `MessagingBroker` with no HTTP transport.',
  ],
  notes:
    'Remains `unverified`: `FCM_SEND_HOST` is fixed to `fcm.googleapis.com` in `firebase-admin/messaging` without an emulator override, and the in-process `MessagingBroker` has no network transport layer where transient HTTP 503 or socket errors occur.',
});
