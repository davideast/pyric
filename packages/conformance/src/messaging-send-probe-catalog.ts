/**
 * Pure metadata catalog for `messaging-send` probes.
 *
 * Kept free of `firebase-admin` and network imports so `staged-captures.ts`,
 * `validate-registry.ts`, `observation-gate.ts`, and CI planning can read
 * `MESSAGING_SEND_PROBES` without initializing an Admin SDK credential.
 */
export interface MessagingSendProbeMetadata {
  name: string;
  rowIds: string[];
  description: string;
  pendingRowLink?: boolean;
}

export const MESSAGING_SEND_PROBES: readonly MessagingSendProbeMetadata[] = [
  {
    name: 'messaging-send-topic-accepted',
    rowIds: ['messaging-admin#4', 'messaging-admin#13'],
    description:
      'firebase-admin/messaging send() to a topic: FCM accepts and returns the message resource name projects/<projectId>/messages/<messageId>. dryRun=true returns a name in the SAME format (fake id), so callers cannot distinguish validation from acceptance by shape alone.',
  },
  {
    name: 'messaging-send-no-target-error-envelope',
    rowIds: ['messaging-admin#4', 'messaging-admin#39'],
    description:
      'v1 messages:send with no recipient: HTTP 400, google.rpc envelope with status INVALID_ARGUMENT, details carrying BOTH google.rpc.BadRequest (fieldViolations naming the field) and google.firebase.fcm.v1.FcmError (errorCode). Detail ORDER differs across error cases and is not a contract.',
  },
  {
    name: 'messaging-send-invalid-token-error-envelope',
    rowIds: ['messaging-admin#4', 'messaging-admin#12', 'messaging-admin#39'],
    description:
      'v1 messages:send with a syntactically invalid registration token: HTTP 400 INVALID_ARGUMENT; fieldViolations names message.token; FcmError errorCode INVALID_ARGUMENT. Note details array order differs from the no-target case.',
  },
  {
    name: 'messaging-send-condition-accepted',
    rowIds: ['messaging-admin#4', 'messaging-admin#14'],
    description:
      "firebase-admin/messaging send() with a condition target of the form \"'a' in topics && 'b' in topics\": FCM accepts and returns projects/<projectId>/messages/<messageId>, the same resource-name shape as a direct topic send, with no subscribers required. dryRun=true returns the same shape.",
  },
  {
    name: 'messaging-send-invalid-condition-error-envelope',
    rowIds: ['messaging-admin#4', 'messaging-admin#14'],
    description:
      'v1 messages:send with a syntactically malformed condition ("\'a\' in topics &&", dangling operator): the error envelope FCM returns (HTTP status + google.rpc envelope). realSendEnvelopeIdentical records whether validate_only=false returns the byte-identical envelope.',
  },
  {
    name: 'messaging-send-invalid-topic-name-error-envelope',
    rowIds: ['messaging-admin#4', 'messaging-admin#13'],
    description:
      "v1 messages:send with a topic name containing characters outside the documented [a-zA-Z0-9-_.~%] set ('bad#topic!name'): the error envelope FCM returns. realSendEnvelopeIdentical records validate_only=false parity.",
  },
  {
    name: 'messaging-send-oversized-payload-error-envelope',
    rowIds: ['messaging-admin#4'],
    description:
      'v1 messages:send with a data payload over the documented 4096-byte cap: the error envelope FCM returns, plus the bisected accept/reject boundary. behavior.documentedCapBytes is the published cap; largestAcceptedDataValueLen/smallestRejectedDataValueLen pin where a minimal single-field topic message actually flips (value length, not total bytes - total includes JSON framing). realSendEnvelopeIdentical records validate_only parity.',
  },
  {
    name: 'messaging-send-notification-only-vs-data-only-accepted',
    rowIds: ['messaging-admin#4', 'messaging-admin#11', 'messaging-admin#16'],
    description:
      'firebase-admin/messaging send() to a topic with ONLY a notification block, and separately with ONLY a data block: FCM accepts both and returns the same projects/<projectId>/messages/<messageId> resource-name shape; neither a data nor a notification block is individually required.',
  },
  {
    name: 'messaging-send-webpush-config-accepted',
    rowIds: ['messaging-admin#4', 'messaging-admin#18', 'messaging-admin#19'],
    description:
      'firebase-admin/messaging send() with a webpush config carrying headers.TTL="3600" and fcmOptions.link="https://example.com/oracle": FCM accepts and returns the standard resource-name shape. dryRun=true matches.',
  },
  {
    name: 'messaging-send-webpush-invalid-ttl-error-envelope',
    rowIds: ['messaging-admin#4', 'messaging-admin#18'],
    description:
      'v1 messages:send with webpush.headers.TTL set to a non-numeric value ("not-a-number"): the error envelope FCM returns. realSendEnvelopeIdentical records validate_only=false parity.',
  },
  {
    name: 'messaging-send-webpush-lowercase-ttl',
    rowIds: ['messaging-admin#4', 'messaging-admin#18'],
    description:
      'v1 messages:send with lowercase webpush.headers.ttl set to "60", "-1", and "abc" across validate_only=true and validate_only=false on a zero-subscriber topic: records whether FCM validates lowercase headers.ttl case-insensitively like uppercase headers.TTL.',
  },
];
