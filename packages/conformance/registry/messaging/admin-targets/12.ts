import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["BaseMessage","TokenMessage"],
  flipped: 'oracle-backed',
  api: 'interface TokenMessage extends BaseMessage { token: string }',
  behavior:
    'A device-token target. A syntactically invalid token is rejected with HTTP 400 INVALID_ARGUMENT whose fieldViolations name `message.token`.',
  evidence: 'oracle: `messaging-send-invalid-token-error-envelope.json` (fieldViolations names message.token). Replayed by the conformance suite.',
  observations: ['messaging-send-invalid-token-error-envelope'],
});
