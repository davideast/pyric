/**
 * Offline differential oracle for installed `firebase-admin/messaging`
 * (`v14.5.1`).
 *
 * 1. Client-side preflight (`acceptedPreflight: false`): runs `firebase-admin/messaging`
 *    with a synthetic credential (`projectId: 'demo-project'`) and
 *    `enableLegacyHttpTransport()`, intercepting `httpClient.send` and
 *    `http2Client.send` before any network socket opens (`getMessaging`,
 *    `dryRun`, `sendEach`, `sendEachForMulticast`, `subscribeToTopic`,
 *    `unsubscribeFromTopic`, and `Message` validation).
 * 2. Server-side FCM HTTP v1 / topicSubscriptions wire rules (`acceptedPreflight: true`):
 *    enforces `condition` expression grammar, registration `token` syntax and
 *    active status, `webpush.headers.TTL` integer digits, and the `4915`-byte
 *    `data` payload cap captured in `observations/messaging-admin/*.json`.
 * 3. Documented CDD wire-observation vs client-SDK code notes:
 *    - `{}` (no target keys) and bare invalid-char topics (`"bad topic!"`):
 *      `firebase-admin` throws `messaging/invalid-payload` client-side while
 *      `pyric-admin` throws `messaging/invalid-argument` per raw REST v1 captures.
 *    - truthy non-string `message.topic`: `firebase-admin` throws `TypeError`
 *      (`startsWith`), while `pyric-admin` throws `messaging/invalid-payload`.
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
const WIRE_EMPIRICAL_DATA_CAP_BYTES = 4915;

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
  if (webpush?.headers !== undefined) {
    for (const [headerName, headerValue] of Object.entries(webpush.headers)) {
      if (headerName.toLowerCase() === 'ttl' && !/^\d+$/.test(String(headerValue))) {
        return fcmErrorEnvelope(
          400,
          'INVALID_ARGUMENT',
          'INVALID_ARGUMENT',
          'TTL must be a non-negative integer.',
        );
      }
    }
  }

  const android = wireMessage.android as
    | { fcm_options?: { analytics_label?: unknown }; fcmOptions?: { analyticsLabel?: unknown } }
    | undefined;
  let wireAndroidLabel: unknown;
  if (android?.fcm_options !== undefined) {
    wireAndroidLabel = android.fcm_options.analytics_label;
  } else if (android?.fcmOptions !== undefined) {
    wireAndroidLabel = android.fcmOptions.analyticsLabel;
  }
  if (typeof wireAndroidLabel === 'string' && wireAndroidLabel.length > 50) {
    return fcmErrorEnvelope(
      400,
      'INVALID_ARGUMENT',
      'INVALID_ARGUMENT',
      `Invalid analytics label: ${wireAndroidLabel}`,
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
    data?: Record<string, unknown>;
  }): Promise<HttpStubResponse> => {
    reachedHttp = true;
    const v1TopicMatch = /\/v1\/projects\/[^/]+\/registrations\/([^/]+)\/topicSubscriptions(?:\/|\?|$)/.exec(
      req.url,
    );
    if (v1TopicMatch !== null) {
      const rawToken = decodeURIComponent(v1TopicMatch[1] ?? '');
      if (!WIRE_TOKEN_SHAPE_RE.test(rawToken)) {
        const badBody = {
          error: {
            code: 400,
            status: 'INVALID_ARGUMENT',
            message: 'Invalid registration token.',
          },
        };
        return {
          status: 400,
          headers: { 'content-type': 'application/json' },
          text: JSON.stringify(badBody),
          data: badBody,
          isJson: () => true,
        };
      }
      if (unregisteredTokens.has(rawToken)) {
        const missingBody = {
          error: {
            code: 404,
            status: 'NOT_FOUND',
            message: 'Requested entity was not found.',
          },
        };
        return {
          status: 404,
          headers: { 'content-type': 'application/json' },
          text: JSON.stringify(missingBody),
          data: missingBody,
          isJson: () => true,
        };
      }
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        text: '{}',
        data: {},
        isJson: () => true,
      };
    }
    if (req.url.includes('iid.googleapis.com')) {
      const tokens = (req.data?.registration_tokens ?? []) as string[];
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
    const wireMessage = (req.data?.message ?? {}) as Record<string, unknown>;
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
