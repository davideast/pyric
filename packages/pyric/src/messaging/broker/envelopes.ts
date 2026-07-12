/**
 * Captured FCM v1 error envelopes — the send plane's rejection contract.
 *
 * Every constructor here reproduces a committed oracle observation
 * byte-for-byte (`packages/conformance/observations/messaging-admin/messaging-send-*.json`),
 * INCLUDING the per-case ordering of the `details` array. Detail order
 * differs across cases in production and "is not a contract"
 * (`messaging-send-no-target-error-envelope.json` description) — but the
 * broker mirrors each captured case exactly so the conformance suite can
 * deep-equal against the pinned envelope rather than a normalized shape.
 *
 * Per-case detail ordering, as captured:
 *   - no-target:        BadRequest, FcmError
 *   - invalid token:    FcmError, BadRequest   ← the one flipped case
 *   - invalid topic:    BadRequest, FcmError
 *   - oversized:        BadRequest (NO fieldViolations key), FcmError
 *   - webpush bad TTL:  BadRequest, FcmError
 *   - invalid condition: NO details at all (the "bare" envelope)
 *   - unregistered:     FcmError only (404 / NOT_FOUND)
 */

/** `type.googleapis.com/google.rpc.BadRequest` detail. */
export interface BadRequestDetail {
  '@type': 'type.googleapis.com/google.rpc.BadRequest';
  fieldViolations?: Array<{ field: string; description: string }>;
}

/** `type.googleapis.com/google.firebase.fcm.v1.FcmError` detail. */
export interface FcmErrorDetail {
  '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError';
  errorCode: string;
}

export type ErrorDetail = BadRequestDetail | FcmErrorDetail;

/**
 * The `google.rpc` error envelope FCM's REST plane returns, as the broker
 * models it: HTTP status + the `error` object. `details` is absent (not
 * empty) on the bare invalid-condition case, matching the capture.
 */
export interface FcmErrorEnvelope {
  status: number;
  error: {
    code: number;
    message: string;
    status: string;
    details?: ErrorDetail[];
  };
}

const BAD_REQUEST = 'type.googleapis.com/google.rpc.BadRequest' as const;
const FCM_ERROR = 'type.googleapis.com/google.firebase.fcm.v1.FcmError' as const;

function badRequest(field: string, description: string): BadRequestDetail {
  return { '@type': BAD_REQUEST, fieldViolations: [{ field, description }] };
}

function fcmError(errorCode: string): FcmErrorDetail {
  return { '@type': FCM_ERROR, errorCode };
}

function invalidArgument(message: string, details: ErrorDetail[]): FcmErrorEnvelope {
  return {
    status: 400,
    error: { code: 400, message, status: 'INVALID_ARGUMENT', details },
  };
}

/** oracle: `messaging-send-no-target-error-envelope` (details: BadRequest, FcmError). */
export function noTargetEnvelope(): FcmErrorEnvelope {
  const message = 'Recipient of the message is not set.';
  return invalidArgument(message, [badRequest('message', message), fcmError('INVALID_ARGUMENT')]);
}

/**
 * Multiple targets set at once. UNOBSERVED: production was only captured for
 * the zero-target case; the multi-target message text below is stated from
 * firebase-admin's own validator, not a wire capture — a probe candidate.
 * The envelope shape mirrors the no-target case (same fault family).
 */
export function multipleTargetsEnvelope(): FcmErrorEnvelope {
  const message = 'Exactly one of token, topic or condition is required.';
  return invalidArgument(message, [badRequest('message', message), fcmError('INVALID_ARGUMENT')]);
}

/** oracle: `messaging-send-invalid-token-error-envelope` (details: FcmError, BadRequest — the flipped order). */
export function invalidTokenEnvelope(): FcmErrorEnvelope {
  const message = 'The registration token is not a valid FCM registration token';
  return invalidArgument(message, [fcmError('INVALID_ARGUMENT'), badRequest('message.token', message)]);
}

/** oracle: `messaging-send-invalid-topic-name-error-envelope` (details: BadRequest, FcmError). */
export function invalidTopicNameEnvelope(): FcmErrorEnvelope {
  const message = 'Topic name contains invalid characters.';
  return invalidArgument(message, [badRequest('message', message), fcmError('INVALID_ARGUMENT')]);
}

/**
 * oracle: `messaging-send-invalid-condition-error-envelope` — the BARE
 * envelope: no `details` key at all, only code/message/status.
 */
export function invalidConditionEnvelope(): FcmErrorEnvelope {
  return {
    status: 400,
    error: {
      code: 400,
      message: 'Request contains an invalid argument.',
      status: 'INVALID_ARGUMENT',
    },
  };
}

/**
 * oracle: `messaging-send-oversized-payload-error-envelope` — the BadRequest
 * detail carries NO `fieldViolations` key (captured exactly so).
 */
export function oversizedPayloadEnvelope(): FcmErrorEnvelope {
  return invalidArgument('Message is too large. The maximum is 4K (4096 bytes).', [
    { '@type': BAD_REQUEST },
    fcmError('INVALID_ARGUMENT'),
  ]);
}

/** oracle: `messaging-send-webpush-invalid-ttl-error-envelope` (details: BadRequest, FcmError). */
export function invalidWebpushTtlEnvelope(): FcmErrorEnvelope {
  const message = 'TTL must be a non-negative integer.';
  return invalidArgument(message, [
    badRequest('message.webpush.headers.TTL', message),
    fcmError('INVALID_ARGUMENT'),
  ]);
}

/**
 * oracle: `messaging-web-deletetoken-unregistered` — the send plane's
 * eventual answer for a deleted (or never-registered, well-formed) token:
 * HTTP 404, status NOT_FOUND, a single FcmError detail with errorCode
 * UNREGISTERED. The observation pins the message as *present* but drops its
 * text as prod noise; the text below is production's standard NOT_FOUND
 * message, stated at documentation strength.
 */
export function unregisteredTokenEnvelope(): FcmErrorEnvelope {
  return {
    status: 404,
    error: {
      code: 404,
      message: 'Requested entity was not found.',
      status: 'NOT_FOUND',
      details: [fcmError('UNREGISTERED')],
    },
  };
}

/** Pull the FcmError errorCode out of an envelope (mirror of the suite's helper). */
export function fcmErrorCodeOf(envelope: FcmErrorEnvelope): string | undefined {
  const detail = envelope.error.details?.find(
    (d): d is FcmErrorDetail => d['@type'] === FCM_ERROR,
  );
  return detail?.errorCode;
}

/**
 * A rejected broker operation. Carries the full captured-shape envelope so
 * admin mirrors (and, later, worker-host op handlers) can re-wrap it into
 * their own error surface without losing wire fidelity.
 */
export class BrokerSendError extends Error {
  readonly envelope: FcmErrorEnvelope;
  /** The FcmError errorCode when the envelope carries one (`INVALID_ARGUMENT`, `UNREGISTERED`, …). */
  readonly errorCode: string | undefined;

  constructor(envelope: FcmErrorEnvelope) {
    super(envelope.error.message);
    this.name = 'BrokerSendError';
    this.envelope = envelope;
    this.errorCode = fcmErrorCodeOf(envelope);
  }
}
