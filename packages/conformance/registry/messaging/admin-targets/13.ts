import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["BaseMessage","TopicMessage"],
  flipped: 'oracle-backed',
  api: 'interface TopicMessage extends BaseMessage { topic: string }',
  behavior:
    'A topic target. A well-formed topic send is accepted and returns the standard resource name (no subscribers required); a topic name containing characters outside the documented `[a-zA-Z0-9-_.~%]` set is rejected with an INVALID_ARGUMENT error envelope.',
  evidence: 'oracle: `messaging-send-topic-accepted.json` (accepted) + `messaging-send-invalid-topic-name-error-envelope.json` (bad name rejected). Replayed by the conformance suite.',
  observations: ['messaging-send-topic-accepted', 'messaging-send-invalid-topic-name-error-envelope'],
});
