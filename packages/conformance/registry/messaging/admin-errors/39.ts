import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["MessagingClientErrorCode"],
  flipped: 'oracle-backed',
  api: 'class MessagingClientErrorCode',
  behavior:
    'Exported static `{ code, message }` members (`INVALID_ARGUMENT`, `INVALID_RECIPIENT`, `INVALID_PAYLOAD`, … `UNKNOWN_ERROR`). The wire-level `INVALID_ARGUMENT` FcmError returned by malformed sends maps to `MessagingClientErrorCode.INVALID_ARGUMENT`.',
  evidence:
    'oracle: `messaging-send-no-target-error-envelope.json` + `messaging-send-invalid-token-error-envelope.json` (both carry the INVALID_ARGUMENT FcmError). Replayed by the conformance suite.',
  observations: ['messaging-send-no-target-error-envelope', 'messaging-send-invalid-token-error-envelope'],
});
