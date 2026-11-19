import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["send", "enableLegacyHttpTransport"],
  api: 'Send retry and backoff on transient transport failures',
  behavior:
    'The admin SDK retries transient send-transport failures — connection errors and HTTP 5xx / `SERVER_UNAVAILABLE` / `INTERNAL` responses — with backoff before surfacing the error to the caller, so a caller sees a resolved send or a terminal error rather than every intermediate failure. `enableLegacyHttpTransport` switches `sendEach` / `sendEachForMulticast` from HTTP/2 to HTTP/1.1, changing multiplexing and the retry/transport path. Stated from the admin SDK and google-auth transport documentation; no committed observation replays the retry count or backoff schedule yet.',
  evidence:
    'Upstream documentation (firebase-admin 13.10.0 send transport + google-auth retry defaults); no observation yet. Candidate probe: point the send transport at a fault-injecting stub that returns 503 then 200 and record the retry count and backoff intervals before the resolved send.',
  riskReasons: [
    'Send retry/backoff on transient 5xx and connection failures stated from admin SDK / transport documentation only; no committed observation records the retry count or backoff schedule — a probe candidate before implementation.',
  ],
  notes:
    'Candidate capture for the re-capture lane (#444): a fault-injecting stub endpoint returning 503 then 200, asserting the SDK retries with backoff and the caller observes a single resolved send.',
});
