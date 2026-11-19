import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["BaseMessage","ConditionMessage"],
  flipped: 'oracle-backed',
  api: 'interface ConditionMessage extends BaseMessage { condition: string }',
  behavior:
    'A condition target. A well-formed condition of the form `"\'a\' in topics && \'b\' in topics"` is accepted with the standard resource-name shape (no subscribers required); a malformed condition (dangling operator) is rejected with an error envelope.',
  evidence:
    'oracle: `messaging-send-condition-accepted.json` (accepted) + `messaging-send-invalid-condition-error-envelope.json` (malformed rejected). Replayed by the conformance suite.',
  observations: ['messaging-send-condition-accepted', 'messaging-send-invalid-condition-error-envelope'],
});
