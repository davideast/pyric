import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["Messaging","subscribeToTopic"],
  flipped: 'oracle-backed',
  api: 'Messaging.subscribeToTopic(tokenOrTokens, topic): Promise<MessagingTopicManagementResponse>',
  behavior: 'Subscribes one or many registration tokens to a topic; resolves a `MessagingTopicManagementResponse`.',
  evidence: 'oracle: `messaging-send-topic-subscribe-batch.json` (live IID `/iid/v1:batchAdd` per-index error mapping, `/topics/` normalization, and sync vs async validation guards). Replayed by the conformance suite.',
  observations: ['messaging-send-topic-subscribe-batch'],
});
