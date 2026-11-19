import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["Message","TokenMessage","TopicMessage","ConditionMessage"],
  flipped: 'oracle-backed',
  api: 'type Message = TokenMessage | TopicMessage | ConditionMessage',
  behavior: 'A send payload carrying exactly one of token, topic, or condition.',
  evidence: 'oracle: `messaging-send-multiple-targets-rejected.json` (client preflight `messaging/invalid-payload` and raw FCM v1 `oneof target` rejection when multiple targets are set). Replayed by the conformance suite.',
  observations: ['messaging-send-multiple-targets-rejected'],
});
