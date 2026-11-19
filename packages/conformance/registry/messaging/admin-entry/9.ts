import { row } from './section.ts';

export default row({
  order: 90,
  featureKeys: ["sendEach","sendEachForMulticast"],
  flipped: 'oracle-backed',
  api: 'Messaging.enableLegacyHttpTransport(): void',
  behavior: 'Forces HTTP/1.1 transport for `sendEach` / `sendEachForMulticast`; deprecated.',
  evidence: 'oracle: `messaging-send-legacy-http-transport.json` (returns `undefined` and preserves `BatchResponse` semantics). Replayed by the conformance suite.',
  observations: ['messaging-send-legacy-http-transport'],
});
