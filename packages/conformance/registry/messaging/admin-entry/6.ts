import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["sendEach"],
  flipped: 'oracle-backed',
  api: 'Messaging.sendEachForMulticast(message, dryRun?): Promise<BatchResponse>',
  behavior: 'Fans a `MulticastMessage` (up to 500 tokens) out through `sendEach`.',
  evidence: 'oracle: `messaging-send-multicast-batch.json` (ordered per-token `SendResponse` outcomes plus null, empty, and >500 token guards). Replayed by the conformance suite.',
  observations: ['messaging-send-multicast-batch'],
});
