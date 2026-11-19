import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["BaseMessage"],
  flipped: 'oracle-backed',
  api: 'interface MulticastMessage extends BaseMessage { tokens: string[] }',
  behavior: 'A multicast target of up to 500 tokens, fanned out by `sendEachForMulticast`.',
  evidence: 'oracle: `messaging-send-multicast-batch.json` (ordered per-token `SendResponse` outcomes and null/empty/>500 token preflight guards). Replayed by the conformance suite.',
  observations: ['messaging-send-multicast-batch'],
});
