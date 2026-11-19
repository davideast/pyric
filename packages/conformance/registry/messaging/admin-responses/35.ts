import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["MessagingTopicManagementResponse"],
  flipped: 'oracle-backed',
  api: 'interface MessagingTopicManagementResponse { failureCount; successCount; errors }',
  behavior: 'Topic subscribe / unsubscribe result carrying per-index errors as `FirebaseArrayIndexError[]`.',
  evidence: 'oracle: `messaging-send-topic-subscribe-batch.json` + `messaging-send-topic-unsubscribe-batch.json` (`successCount`, `failureCount`, and per-index `errors` with `FirebaseMessagingError`). Replayed by the conformance suite.',
  observations: ['messaging-send-topic-subscribe-batch', 'messaging-send-topic-unsubscribe-batch'],
});
