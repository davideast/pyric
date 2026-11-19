import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["Messaging","send"],
  flipped: 'oracle-backed',
  api: 'Messaging.send(message, dryRun?): Promise<string>',
  behavior:
    'Sends one message via FCM v1 and resolves with the resource name `projects/<projectId>/messages/<messageId>`. `dryRun=true` returns the SAME shape (fake id), so callers cannot distinguish validation from acceptance by shape. Topic, condition, token, notification-only, data-only, and webpush-config sends are all accepted. Malformed sends fail server-side validation with HTTP 4xx `google.rpc` error envelopes carrying both a `google.rpc.BadRequest` (fieldViolations) and a `google.firebase.fcm.v1.FcmError` (errorCode); detail ordering is not contractual. The documented data-payload cap is 4096 bytes.',
  evidence: 'oracle: 11 send-plane observations - accept paths `messaging-send-topic-accepted`, `messaging-send-condition-accepted`, `messaging-send-notification-only-vs-data-only-accepted`, `messaging-send-webpush-config-accepted`; error envelopes and case-insensitive header checks `messaging-send-no-target-error-envelope`, `messaging-send-invalid-token-error-envelope`, `messaging-send-invalid-condition-error-envelope`, `messaging-send-invalid-topic-name-error-envelope`, `messaging-send-oversized-payload-error-envelope`, `messaging-send-webpush-invalid-ttl-error-envelope`, `messaging-send-webpush-lowercase-ttl`. Replayed by the conformance suite.',
  observations: ['messaging-send-topic-accepted', 'messaging-send-condition-accepted', 'messaging-send-notification-only-vs-data-only-accepted', 'messaging-send-webpush-config-accepted', 'messaging-send-no-target-error-envelope', 'messaging-send-invalid-token-error-envelope', 'messaging-send-invalid-condition-error-envelope', 'messaging-send-invalid-topic-name-error-envelope', 'messaging-send-oversized-payload-error-envelope', 'messaging-send-webpush-invalid-ttl-error-envelope', 'messaging-send-webpush-lowercase-ttl'],
});
