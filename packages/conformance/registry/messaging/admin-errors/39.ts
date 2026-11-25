import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ['MessagingErrorCode'],
  flipped: 'oracle-backed',
  api: 'const MessagingErrorCode',
  behavior:
    'Exported constant object mapping all 21 `firebase-admin/messaging` error keys (`INVALID_ARGUMENT`, `INVALID_RECIPIENT`, `INVALID_PAYLOAD`, ..., `UNKNOWN_ERROR`) to their unprefixed string codes. The wire-level `INVALID_ARGUMENT` FcmError returned by malformed sends maps to `MessagingErrorCode.INVALID_ARGUMENT`.',
  evidence:
    'oracle: `messaging-send-no-target-error-envelope.json` + `messaging-send-invalid-token-error-envelope.json` (both carry the INVALID_ARGUMENT FcmError). Replayed by the conformance suite.',
  observations: ['messaging-send-no-target-error-envelope', 'messaging-send-invalid-token-error-envelope'],
});
