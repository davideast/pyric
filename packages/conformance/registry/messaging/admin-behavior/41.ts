import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["send", "enableLegacyHttpTransport"],
  api: 'Send retry and backoff on transient transport failures',
  behavior:
    'In `firebase-admin` 13.10.0 (`lib/utils/api-request.js` `defaultRetryConfig()`), both `AuthorizedHttpClient` (HTTP/1.1) and `AuthorizedHttp2Client` (HTTP/2) retry up to `maxRetries: 4` on HTTP `503` (`statusCodes: [503]`; HTTP `500` `INTERNAL` is not retried) and low-level `ECONNRESET` / `ETIMEDOUT` I/O errors, honoring `Retry-After` headers or exponential backoff (`0ms` on first retry, then `(2 ** retryAttempts) * 0.5s` up to `60000ms`). `enableLegacyHttpTransport` switches `sendEach` and `sendEachForMulticast` from `AuthorizedHttp2Client` (`Http2SessionHandler` over `https://fcm.googleapis.com`) to `AuthorizedHttpClient` (HTTP/1.1). `pyric-admin/messaging` dispatches in-memory to `MessagingBroker` without an HTTP retry layer, and no production observation records transport retry intervals.',
  evidence:
    'Staged `messaging-send` probe `packages/conformance/probes/messaging-admin/messaging-send-transport-retry-backoff.ts` (`pendingRowLink: true`) plus loopback HTTP/1.1 + HTTP/2 fault-injection verification in `packages/conformance/test/src/messaging-send-behavior-probes.test.ts`; awaiting automated main-branch observation capture before linking.',
  riskReasons: [
    'Staged `messaging-send` probe `messaging-send-transport-retry-backoff` (`pendingRowLink: true`) has no committed observation file under `packages/conformance/observations/messaging-admin/` yet, and `pyric-admin/messaging` dispatches in-memory to `MessagingBroker` without an HTTP transport.',
  ],
  notes:
    'Staged for automated `messaging-send` capture on `main`: once `messaging-send-transport-retry-backoff.json` lands, link `observations`, drop `pendingRowLink`, and record the by-design in-memory vs HTTP transport divergence.',
});
