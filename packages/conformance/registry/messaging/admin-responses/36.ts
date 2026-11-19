import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["SendResponse"],
  flipped: 'oracle-backed',
  api: 'interface BatchResponse { responses; successCount; failureCount }',
  behavior: 'Batch send result; `responses` is a `SendResponse[]`.',
  evidence: 'oracle: `messaging-send-sendeach-mixed-batch.json` + `messaging-send-multicast-batch.json` (`responses`, `successCount`, and `failureCount` match input order). Replayed by the conformance suite.',
  observations: ['messaging-send-sendeach-mixed-batch', 'messaging-send-multicast-batch'],
});
