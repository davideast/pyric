import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["Messaging","sendEach"],
  flipped: 'oracle-backed',
  api: 'Messaging.sendEach(messages, dryRun?): Promise<BatchResponse>',
  behavior:
    'Sends an array of up to 500 messages, one RPC per message; resolves a `BatchResponse` whose `responses` are ordered to match the input. Total failure is signalled by a throw or an all-failure `BatchResponse`.',
  evidence: 'oracle: `messaging-send-sendeach-mixed-batch.json` (ordered per-item success/wire/preflight settlement) + `messaging-send-sendeach-validation-guards.json` (empty, >500, and non-boolean `dryRun` guards). Replayed by the conformance suite.',
  observations: ['messaging-send-sendeach-mixed-batch', 'messaging-send-sendeach-validation-guards'],
});
