import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: ["Messaging","unsubscribeFromTopic"],
  flipped: 'oracle-backed',
  api: 'Messaging.unsubscribeFromTopic(tokenOrTokens, topic): Promise<MessagingTopicManagementResponse>',
  behavior: 'Unsubscribes one or many registration tokens from a topic; resolves a `MessagingTopicManagementResponse`.',
  evidence: 'oracle: `messaging-send-topic-unsubscribe-batch.json` (live IID `/iid/v1:batchRemove` per-index error mapping, `/topics/` normalization, and sync vs async validation guards). Replayed by the conformance suite.',
  observations: ['messaging-send-topic-unsubscribe-batch'],
});
