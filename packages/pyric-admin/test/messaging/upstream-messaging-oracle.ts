/**
 * Offline differential oracle for installed `firebase-admin/messaging`
 * (`v13.10.0`).
 *
 * -- Exact Two-Layer Oracle Boundary ------------------------------------------
 * 1. Client-side preflight (`acceptedPreflight: false`):
 *    Runs the real installed `firebase-admin/messaging` with a synthetic dummy
 *    credential (`projectId: 'demo-project'`) and `enableLegacyHttpTransport()`,
 *    intercepting `messagingRequestHandler.httpClient.send` and
 *    `http2Client.send` BEFORE any network socket opens. Any synchronous throw
 *    or pre-HTTP rejection (or per-entry `BatchResponse` rejection prior to
 *    HTTP) comes directly from `firebase-admin` itself:
 *      - `getMessaging(app)` / `admin.messaging(app)` app handle brand & no-app
 *      - `dryRun` boolean type check (`messaging/invalid-argument`)
 *      - `sendEach` non-empty array & `<= 500` batch limit (`messaging/invalid-argument`)
 *      - `sendEachForMulticast` object, `tokens` non-empty array & `<= 500` limit
 *      - `subscribeToTopic` / `unsubscribeFromTopic` token string/array type,
 *        non-empty string elements, `<= 1000` batch limit, and normalized
 *        `/topics/[a-zA-Z0-9-_.~%]+` topic format (`messaging/invalid-argument`)
 *      - `Message` non-null object container, single `/topics/` prefix strip +
 *        topic charset, target presence, `data` / `webpush.headers` /
 *        `webpush.data` / `android.data` / `apns.headers` string-only maps, and
 *        `notification` / `webpush` / `android` / `apns` / `fcmOptions` shapes
 *        (`messaging/invalid-payload`)
 *
 * 2. Server-side FCM HTTP v1 / IID wire rules (`acceptedPreflight: true`):
 *    `firebase-admin@13.10.0` does NOT validate the following client-side; they
 *    pass preflight (`acceptedPreflight: true`) and are enforced by FCM HTTP v1
 *    or IID on the wire (captured in `packages/conformance/observations/messaging-admin/*.json`):
 *      - `condition` boolean expression grammar: `'name' in topics` clauses
 *        with mandatory whitespace around `in` and `topics`, bare topic charset
 *        `[a-zA-Z0-9-_.~%]+`, operators `!` / `&&` / `||` / `(...)`, and at most
 *        5 topic clauses (`messaging-send-condition-accepted.json`,
 *        `messaging-send-invalid-condition-error-envelope.json`)
 *      - registration `token` URL-safe `segment:segment` syntax and active
 *        registration status (`messaging-send-invalid-token-error-envelope.json`,
 *        `messaging-web-deletetoken-unregistered.json`)
 *      - `webpush.headers.TTL` non-negative integer digits
 *        (`messaging-send-webpush-invalid-ttl-error-envelope.json`)
 *      - empirical `data` payload byte cap (`4506` UTF-8 key+value bytes,
 *        `messaging-send-oversized-payload-error-envelope.json`)
 *
 * 3. Documented CDD wire-observation vs client-SDK code notes:
 *    Both sides REJECT (`accepted: false`) in every case below, differing only
 *    in error code because `oracle-conformance.test.ts` replays raw FCM REST v1
 *    captures (`messaging-send-probes.ts` `rawSend`) or avoids an unguarded
 *    upstream `startsWith` crash:
 *      - plain object with zero present target keys (`{}`):
 *        `firebase-admin` throws `messaging/invalid-payload` client-side;
 *        `pyric-admin` throws `messaging/invalid-argument` per
 *        `messaging-send-no-target-error-envelope.json`
 *      - bare non-slash invalid-character topic (`"bad topic!"`):
 *        `firebase-admin` throws `messaging/invalid-payload` client-side;
 *        `pyric-admin` throws `messaging/invalid-argument` per
 *        `messaging-send-invalid-topic-name-error-envelope.json`
 *      - truthy non-string `message.topic` (`{ topic: 1 | true | [] | {} }`):
 *        `firebase-admin@13.10.0` crashes with unguarded `TypeError`
 *        (`anyMessage.topic.startsWith is not a function`,
 *        `messaging-internal.js:44`); `pyric-admin` rejects cleanly with
 *        `FirebaseMessagingError` (`messaging/invalid-payload`)
 */

import {
  deleteApp as deleteUpstreamApp,
  initializeApp as initializeUpstreamApp,
  type App as UpstreamApp,
} from 'firebase-admin/app';
import {
  getMessaging as getUpstreamMessaging,
  type Messaging as UpstreamMessaging,
} from 'firebase-admin/messaging';

export interface NormalizedCallOutcome {
  readonly accepted: boolean;
  readonly acceptedPreflight?: boolean;
  readonly errorKind?: 'TypeError' | 'FirebaseError' | 'OtherError';
  readonly code?: string;
  readonly batchSummary?: {
    readonly successCount: number;
    readonly failureCount: number;
    readonly itemOutcomes: ReadonlyArray<{
      readonly success: boolean;
      readonly errorKind?: 'TypeError' | 'FirebaseError' | 'OtherError';
      readonly code?: string;
    }>;
  };
  readonly topicSummary?: {
    readonly successCount: number;
    readonly failureCount: number;
    readonly errorCodes: ReadonlyArray<{ readonly index: number; readonly code?: string }>;
  };
}

interface HttpStubResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly text: string;
  readonly data: unknown;
  readonly isJson: () => boolean;
}

const WIRE_TOPIC_CHAR_RE = /^[a-zA-Z0-9-_.~%]+$/;
const WIRE_TOKEN_SHAPE_RE = /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;
const WIRE_MAX_CONDITION_CLAUSES = 5;
const WIRE_EMPIRICAL_DATA_CAP_BYTES = 4506;

/**
 * Independent server-side FCM v1 condition grammar recognizer for requests that
 * pass `firebase-admin` client preflight (`acceptedPreflight: true`).
 */
function fcmServerAcceptsCondition(source: string): boolean {
  let cursor = 0;
  let clauseCount = 0;

  const skipSpaces = (): number => {
    const start = cursor;
    while (cursor < source.length && /\s/.test(source.charAt(cursor))) {
      cursor += 1;
    }
    return cursor - start;
  };

  const parseOr = (): boolean => {
    if (!parseAnd()) return false;
    for (;;) {
      skipSpaces();
      if (source.startsWith('||', cursor)) {
        cursor += 2;
        if (!parseAnd()) return false;
        continue;
      }
      return true;
    }
  };

  const parseAnd = (): boolean => {
    if (!parseUnary()) return false;
    for (;;) {
      skipSpaces();
      if (source.startsWith('&&', cursor)) {
        cursor += 2;
        if (!parseUnary()) return false;
        continue;
      }
      return true;
    }
  };

  const parseUnary = (): boolean => {
    skipSpaces();
    if (source.startsWith('!', cursor)) {
      cursor += 1;
      return parseUnary();
    }
    if (source.startsWith('(', cursor)) {
      cursor += 1;
      if (!parseOr()) return false;
      skipSpaces();
      if (!source.startsWith(')', cursor)) return false;
      cursor += 1;
      return true;
    }
    if (source.charAt(cursor) !== "'") return false;
    cursor += 1;
    const topicStart = cursor;
    while (cursor < source.length && source.charAt(cursor) !== "'") {
      cursor += 1;
    }
    if (cursor >= source.length) return false;
    const topicName = source.slice(topicStart, cursor);
    cursor += 1;
    if (skipSpaces() === 0) return false;
    if (!source.startsWith('in', cursor)) return false;
    cursor += 2;
    if (skipSpaces() === 0) return false;
    if (!source.startsWith('topics', cursor)) return false;
    cursor += 6;
    if (topicName.length === 0 || !WIRE_TOPIC_CHAR_RE.test(topicName)) return false;
    clauseCount += 1;
    return clauseCount <= WIRE_MAX_CONDITION_CLAUSES;
  };

  if (!parseOr()) return false;
  skipSpaces();
  return cursor === source.length;
}

function fcmErrorEnvelope(
  status: number,
  rpcStatus: string,
  fcmCode: string,
  message: string,
): HttpStubResponse {
  const payload = {
    error: {
      code: status,
      message,
      status: rpcStatus,
      details: [
        {
          '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
          errorCode: fcmCode,
        },
      ],
    },
  };
  return {
    status,
    headers: { 'content-type': 'application/json' },
    text: JSON.stringify(payload),
    data: payload,
    isJson: () => true,
  };
}

function evaluateFcmSendWireRequest(
  wireMessage: Record<string, unknown>,
  activeTokens: ReadonlySet<string>,
): HttpStubResponse {
  const targetKeys = ['token', 'topic', 'condition'].filter(
    (key) => key in wireMessage && wireMessage[key] !== undefined,
  );
  if (targetKeys.length !== 1) {
    return fcmErrorEnvelope(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'Exactly one target required.');
  }

  if (typeof wireMessage.token === 'string') {
    if (!WIRE_TOKEN_SHAPE_RE.test(wireMessage.token)) {
      return fcmErrorEnvelope(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'Invalid registration token.');
    }
    if (!activeTokens.has(wireMessage.token)) {
      return fcmErrorEnvelope(404, 'NOT_FOUND', 'UNREGISTERED', 'Requested entity was not found.');
    }
  }

  if (
    typeof wireMessage.condition === 'string' &&
    !fcmServerAcceptsCondition(wireMessage.condition)
  ) {
    return fcmErrorEnvelope(
      400,
      'INVALID_ARGUMENT',
      'INVALID_ARGUMENT',
      'Request contains an invalid argument.',
    );
  }

  const webpush = wireMessage.webpush as { headers?: Record<string, string> } | undefined;
  const ttl = webpush?.headers?.TTL;
  if (ttl !== undefined && !/^\d+$/.test(String(ttl))) {
    return fcmErrorEnvelope(
      400,
      'INVALID_ARGUMENT',
      'INVALID_ARGUMENT',
      'TTL must be a non-negative integer.',
    );
  }

  const data = wireMessage.data as Record<string, string> | undefined;
  if (data !== undefined) {
    const encoder = new TextEncoder();
    let totalBytes = 0;
    for (const [key, val] of Object.entries(data)) {
      totalBytes += encoder.encode(key).length + encoder.encode(val).length;
    }
    if (totalBytes > WIRE_EMPIRICAL_DATA_CAP_BYTES) {
      return fcmErrorEnvelope(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'Message is too large.');
    }
  }

  const okPayload = { name: 'projects/demo-project/messages/100001' };
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    text: JSON.stringify(okPayload),
    data: okPayload,
    isJson: () => true,
  };
}

function hasStringErrorCode(error: unknown): error is { code: string } {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  );
}

function classifyError(error: unknown): {
  errorKind: 'TypeError' | 'FirebaseError' | 'OtherError';
  code?: string;
} {
  if (error instanceof TypeError) {
    return { errorKind: 'TypeError' };
  }
  if (hasStringErrorCode(error)) {
    return {
      errorKind: 'FirebaseError',
      code: error.code,
    };
  }
  return { errorKind: 'OtherError' };
}

function hasBatchResponses(
  result: unknown,
): result is {
  successCount: number;
  failureCount: number;
  responses: Array<{ success: boolean; error?: unknown }>;
} {
  return (
    result !== null &&
    typeof result === 'object' &&
    'responses' in result &&
    Array.isArray((result as { responses: unknown }).responses)
  );
}

function hasTopicErrors(
  result: unknown,
): result is {
  successCount: number;
  failureCount: number;
  errors: Array<{ index: number; error?: unknown }>;
} {
  return (
    result !== null &&
    typeof result === 'object' &&
    'errors' in result &&
    Array.isArray((result as { errors: unknown }).errors)
  );
}

export function normalizeOutcome(result: unknown, acceptedPreflight?: boolean): NormalizedCallOutcome {
  if (hasBatchResponses(result)) {
    return {
      accepted: true,
      acceptedPreflight,
      batchSummary: {
        successCount: result.successCount,
        failureCount: result.failureCount,
        itemOutcomes: result.responses.map((entry) => {
          if (entry.success) {
            return { success: true };
          }
          const info = classifyError(entry.error);
          return { success: false, errorKind: info.errorKind, code: info.code };
        }),
      },
    };
  }

  if (hasTopicErrors(result)) {
    return {
      accepted: true,
      acceptedPreflight,
      topicSummary: {
        successCount: result.successCount,
        failureCount: result.failureCount,
        errorCodes: result.errors.map((entry) => ({
          index: entry.index,
          code: classifyError(entry.error).code,
        })),
      },
    };
  }

  return { accepted: true, acceptedPreflight };
}

function readTransportFlag(didReachTransport?: () => boolean): boolean | undefined {
  if (didReachTransport === undefined) {
    return undefined;
  }
  return didReachTransport();
}

export async function captureOutcome(
  invoke: () => unknown,
  didReachTransport?: () => boolean,
): Promise<NormalizedCallOutcome> {
  try {
    const value = await invoke();
    return normalizeOutcome(value, readTransportFlag(didReachTransport));
  } catch (error) {
    const info = classifyError(error);
    return {
      accepted: false,
      acceptedPreflight: readTransportFlag(didReachTransport),
      errorKind: info.errorKind,
      code: info.code,
    };
  }
}

let upstreamAppCounter = 0;

export interface OfflineUpstreamMessagingHarness {
  readonly app: UpstreamApp;
  readonly svc: UpstreamMessaging;
  readonly getMessaging: typeof getUpstreamMessaging;
  readonly resetTransportFlag: () => void;
  readonly didReachHttp: () => boolean;
  readonly dispose: () => Promise<void>;
}

export function createOfflineUpstreamMessagingHarness(
  activeTokens: ReadonlySet<string>,
  unregisteredTokens: ReadonlySet<string> = new Set(),
): OfflineUpstreamMessagingHarness {
  const app = initializeUpstreamApp(
    {
      projectId: 'demo-project',
      credential: {
        getAccessToken: async () => ({ access_token: 'synthetic-token', expires_in: 3600 }),
      },
    },
    `upstream-diff-${++upstreamAppCounter}`,
  );
  const svc = getUpstreamMessaging(app);
  svc.enableLegacyHttpTransport();

  let reachedHttp = false;
  const requestHandler = (
    svc as unknown as {
      messagingRequestHandler: {
        httpClient: {
          send: (req: { url: string; data: Record<string, unknown> }) => Promise<HttpStubResponse>;
        };
        http2Client: {
          send: (req: { url: string; data: Record<string, unknown> }) => Promise<HttpStubResponse>;
        };
      };
    }
  ).messagingRequestHandler;

  const interceptSend = async (req: {
    url: string;
    data: Record<string, unknown>;
  }): Promise<HttpStubResponse> => {
    reachedHttp = true;
    if (req.url.includes('iid.googleapis.com')) {
      const tokens = req.data.registration_tokens as string[];
      const results = tokens.map((tok) => {
        if (!WIRE_TOKEN_SHAPE_RE.test(tok)) return { error: 'INVALID_ARGUMENT' };
        if (unregisteredTokens.has(tok)) return { error: 'NOT_FOUND' };
        return {};
      });
      const data = { results };
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        text: JSON.stringify(data),
        data,
        isJson: () => true,
      };
    }
    const wireMessage = (req.data.message ?? {}) as Record<string, unknown>;
    return evaluateFcmSendWireRequest(wireMessage, activeTokens);
  };

  requestHandler.httpClient.send = interceptSend;
  requestHandler.http2Client.send = interceptSend;

  return {
    app,
    svc,
    getMessaging: getUpstreamMessaging,
    resetTransportFlag: () => {
      reachedHttp = false;
    },
    didReachHttp: () => reachedHttp,
    dispose: async () => {
      await deleteUpstreamApp(app).catch(() => {});
    },
  };
}

function isPlainMessageRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTargetlessPlainObjectWireDiff(
  presentTargetCount: number,
  upstreamError: { code?: string },
  pyricError: { code?: string },
): boolean {
  return (
    presentTargetCount === 0 &&
    upstreamError.code === 'messaging/invalid-payload' &&
    pyricError.code === 'messaging/invalid-argument'
  );
}

function isBareInvalidCharTopicString(topic: unknown): boolean {
  return (
    typeof topic === 'string' &&
    topic.length > 0 &&
    !topic.startsWith('/topics/') &&
    !topic.includes('/') &&
    !WIRE_TOPIC_CHAR_RE.test(topic)
  );
}

function isBareInvalidCharTopicWireDiff(
  definedTargetCount: number,
  topic: unknown,
  upstreamError: { code?: string },
  pyricError: { code?: string },
): boolean {
  return (
    definedTargetCount === 1 &&
    isBareInvalidCharTopicString(topic) &&
    upstreamError.code === 'messaging/invalid-payload' &&
    pyricError.code === 'messaging/invalid-argument'
  );
}

function isTruthyNonStringTopicStartsWithDiff(
  topic: unknown,
  upstreamError: { errorKind?: string },
  pyricError: { code?: string },
): boolean {
  return (
    Boolean(topic) &&
    typeof topic !== 'string' &&
    upstreamError.errorKind === 'TypeError' &&
    pyricError.code === 'messaging/invalid-payload'
  );
}

export function isDocumentedWireVsClientMessageCodeDiff(
  rawMessage: unknown,
  upstreamError: { errorKind?: string; code?: string },
  pyricError: { errorKind?: string; code?: string },
): boolean {
  if (!isPlainMessageRecord(rawMessage)) {
    return false;
  }
  const presentTargets = ['token', 'topic', 'condition'].filter((key) => key in rawMessage);
  const definedTargets = ['token', 'topic', 'condition'].filter(
    (key) => rawMessage[key] !== undefined,
  );

  if (isTargetlessPlainObjectWireDiff(presentTargets.length, upstreamError, pyricError)) {
    return true;
  }
  if (isBareInvalidCharTopicWireDiff(definedTargets.length, rawMessage.topic, upstreamError, pyricError)) {
    return true;
  }
  if (isTruthyNonStringTopicStartsWithDiff(rawMessage.topic, upstreamError, pyricError)) {
    return true;
  }
  return false;
}
