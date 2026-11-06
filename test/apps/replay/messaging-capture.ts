// Capture M (`packages/conformance/src/capture/messaging-live/recordings/capture-m-wire.json`)
// as `messaging` exchanges, converted when a replay server loads it, so no
// copied fixture can drift from what production sent.
//
// Each Installations and registrations request the SDK sent becomes one
// exchange: its method and path, the header values the replay can check, and
// its body's key set with any value. Capture M keeps header names, not values,
// so the API key is a test value per app (`CAPTURE_M_API_KEYS`), which is how
// the replay tells the allowed app from each denied one; the FIS token header
// must name a token this replay minted; and every other header the SDK sent,
// such as `x-firebase-client`, must be present. The answer is capture M's
// status, `Content-Type` and body. The replay server sets CORS itself, so the
// capture's `Access-Control-*` values, which name the capture's origin, are
// not kept.
//
// The `delete-deleted-token` and `cleanup` requests are the capture script's
// own `fetch`, with headers it built, not the SDK's, so no request shape comes
// from them. Only the answer to `delete-deleted-token` is read: it must equal
// the answer to the SDK's own deleteToken, since the replay answers a delete of
// a token it minted the same way whether or not it was deleted before.
//
// A registration under a FIS token the replay never minted matches no
// exchange and fails closed (400 `pyric_replay_no_recording`, listed in
// `unmatched`): capture M holds no 401, so there is no production answer to
// give it.
//
// The capture's placeholders become test values: `<project>` the project,
// `<sender-id>` `CAPTURE_M_SENDER_ID`, `<vapid-key>` `CAPTURE_M_VAPID_KEY`, and
// the push endpoint and keys a registration answer echoes the push stand-in's
// (`CAPTURE_M_PUSH_SUBSCRIPTION`). `<fid-N>`, `<refresh-token-N>`,
// `<fis-auth-token-N>` and `<fcm-token-N>` become the `fid`, `refreshToken`,
// `fisAuthToken` and `fcmToken` placeholders the replay fills.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertShapesOnly, FORMAT, type Json, type JsonObject, type MessagingApi, type MessagingExchange, type Recording } from './format.ts';

const CAPTURE_M_SOURCE = 'packages/conformance/src/capture/messaging-live/recordings/capture-m-wire.json';
export const CAPTURE_M = fileURLToPath(new URL(`../../../${CAPTURE_M_SOURCE}`, import.meta.url));

/** The apps capture M ran: the main one, three denied keys, and the key restricted to Installations alone. */
export type CaptureMApp = 'main' | 'malformed-key' | 'referrer-blocked' | 'other-api-only' | 'installations-only';

/** The test API key each app sends, which picks its exchanges. Capture M never wrote a key. */
export const CAPTURE_M_API_KEYS: Record<CaptureMApp, string> = {
  main: 'replay-api-key',
  'malformed-key': 'replay-malformed-key',
  'referrer-blocked': 'replay-referrer-blocked-key',
  'other-api-only': 'replay-other-api-only-key',
  'installations-only': 'replay-installations-only-key',
};

/** What `<sender-id>`, the project number, becomes. */
export const CAPTURE_M_SENDER_ID = '1234567890';

/** A test VAPID key: an uncompressed P-256 point, base64url, as the SDK sends `applicationPubKey`. */
export const CAPTURE_M_VAPID_KEY = Buffer.from(Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : i))).toString('base64url');

/**
 * The push subscription the stand-in returns and a registration answer
 * echoes: an endpoint in the shape capture M's redaction found
 * (`https://fcm.googleapis.com/fcm/send/<id>`), a 65-byte `p256dh` point and a
 * 16-byte `auth` secret, all fixed test values.
 */
export const CAPTURE_M_PUSH_SUBSCRIPTION = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/replay-push-endpoint:replay-subscription',
  p256dh: Buffer.from(Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : 255 - i))).toString('base64url'),
  auth: Buffer.from(Uint8Array.from({ length: 16 }, (_, i) => i + 1)).toString('base64url'),
};

/** One request the SDK sent and production's answer, as capture M writes it. */
export interface CaptureMExchange {
  op: string;
  api: MessagingApi;
  action: string;
  method: string;
  host: string;
  path: string;
  requestHeaderNames: string[];
  requestContentType: string;
  requestBodyKeys: string[];
  status: number;
  responseHeaders: Record<string, string>;
  responseBody: Json;
}

/** One getToken or deleteToken the app made, and how it settled. */
export interface CaptureMCall {
  op: string;
  app: CaptureMApp;
  call: 'getToken' | 'deleteToken';
  outcome: 'ok' | 'error';
  error?: JsonObject;
}

/** One push the service worker received, before the SDK read it, and what the SDK handed the app. */
export interface CaptureMPush {
  op: string;
  route: 'foreground' | 'background';
  pushData: JsonObject;
  delivered: { to: string; payload: JsonObject };
}

export interface CaptureM {
  sdkVersion: string;
  exchanges: CaptureMExchange[];
  calls: CaptureMCall[];
  pushes: CaptureMPush[];
}

/** The app each SDK operation ran on. */
const APP_OF_OP: Record<string, CaptureMApp> = {
  getToken: 'main',
  deleteToken: 'main',
  'getToken-after-delete': 'main',
  'deleteToken-again': 'main',
  'denied-malformed-key': 'malformed-key',
  'denied-referrer': 'referrer-blocked',
  'denied-other-api-only': 'other-api-only',
  'installations-only-key-allowed': 'installations-only',
};

/** Operations whose requests the capture script built with its own `fetch`. */
const SCRIPT_OPS = new Set(['delete-deleted-token', 'cleanup']);

/** The headers the replay does not compare: every client sends them, and the answer does not depend on them. */
const UNCOMPARED_HEADERS = new Set(['accept']);

/** Server-issued values and the placeholder each becomes. The match keeps any text before it as the placeholder's prefix. */
const ISSUED = /<(fid|refresh-token|fis-auth-token|fcm-token)-\d+>$/;
const ISSUED_PLACEHOLDER: Record<string, string> = { fid: 'fid', 'refresh-token': 'refreshToken', 'fis-auth-token': 'fisAuthToken', 'fcm-token': 'fcmToken' };

export function readCaptureM(path: string = CAPTURE_M): CaptureM {
  return JSON.parse(readFileSync(path, 'utf8')) as CaptureM;
}

/** Capture M as a replay recording for `project`, checked like any recording. */
export function loadCaptureM(project: string, path: string = CAPTURE_M): Recording {
  const recording = captureMRecording(readCaptureM(path), project);
  assertShapesOnly(recording);
  return recording;
}

export function captureMRecording(capture: CaptureM, project: string): Recording {
  assertDeletedTokenAnswer(capture);
  const exchanges = capture.exchanges
    .map((exchange, index) => ({ exchange, index }))
    .filter(({ exchange }) => !SCRIPT_OPS.has(exchange.op))
    .map(({ exchange, index }) => convert(exchange, index, project));
  return {
    format: FORMAT,
    project,
    source: `converted from capture M (${CAPTURE_M_SOURCE}, firebase ${capture.sdkVersion}) by test/apps/replay/messaging-capture.ts`,
    exchanges,
  };
}

/**
 * A push in capture M's shape for `route`, with test values where the capture
 * kept only a type: the push data the service worker receives, and the
 * payload the SDK must hand the app for it.
 */
export function captureMPush(route: CaptureMPush['route'], capture: CaptureM = readCaptureM()): { pushData: JsonObject; delivered: JsonObject } {
  const push = capture.pushes.find((entry) => entry.route === route);
  if (!push) throw new Error(`capture M has no ${route} push`);
  const values: Record<string, string> = { from: CAPTURE_M_SENDER_ID, fcmMessageId: `replay-message-${route}`, messageId: `replay-message-${route}` };
  return { pushData: fillTypes(push.pushData, values), delivered: fillTypes(push.delivered.payload, values) };
}

/** A copy of `value` with each `"<string>"` the capture wrote replaced by the test value for its key. */
function fillTypes(value: JsonObject, values: Record<string, string>): JsonObject {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (item === '<string>') {
      const filled = values[key];
      if (filled === undefined) throw new Error(`capture M: no test value for the push key ${key}`);
      return [key, filled];
    }
    const isObject = typeof item === 'object' && item !== null && !Array.isArray(item);
    return [key, isObject ? fillTypes(item, values) : item];
  }));
}

/** Throws unless production answered the script's delete of a deleted token as it answered the SDK's deleteToken. */
function assertDeletedTokenAnswer(capture: CaptureM): void {
  const deletedAgain = capture.exchanges.find((exchange) => exchange.op === 'delete-deleted-token');
  const deleted = capture.exchanges.find((exchange) => exchange.op === 'deleteToken');
  if (!deletedAgain || !deleted) throw new Error('capture M: expected a deleteToken and a delete-deleted-token exchange');
  const sameAnswer = deletedAgain.status === deleted.status && JSON.stringify(deletedAgain.responseBody) === JSON.stringify(deleted.responseBody);
  if (!sameAnswer) throw new Error(`capture M: a delete of a deleted token answered ${deletedAgain.status}, unlike deleteToken's ${deleted.status}; the replay cannot answer both from one exchange`);
}

function convert(exchange: CaptureMExchange, index: number, project: string): MessagingExchange {
  const app = APP_OF_OP[exchange.op];
  if (!app) throw new Error(`capture M: no app is known for the operation ${exchange.op}`);
  const placeholders = (text: string) => substitute(text, project);
  const body = bodyOf(exchange.requestBodyKeys);
  return {
    kind: 'messaging',
    id: `capture-m-${index}-${exchange.op}-${exchange.api}-${exchange.action}`,
    api: exchange.api,
    request: {
      method: exchange.method,
      path: pathOf(exchange.path, project),
      headers: requestHeaders(exchange, app),
      ...(body ? { body } : {}),
    },
    response: {
      status: exchange.status,
      headers: { 'content-type': exchange.responseHeaders['content-type']! },
      body: answerOf(exchange.responseBody, placeholders),
    },
  };
}

/** The recorded path with the project filled and a token segment as `{fcmToken}` or `{fid}`. */
function pathOf(path: string, project: string): string {
  return path.split('/').map((segment) => {
    if (/^<fcm-token-\d+>$/.test(segment)) return '{fcmToken}';
    if (/^<fid-\d+>$/.test(segment)) return '{fid}';
    return substitute(segment, project);
  }).join('/');
}

function requestHeaders(exchange: CaptureMExchange, app: CaptureMApp): JsonObject {
  const headers: JsonObject = { 'content-type': exchange.requestContentType };
  for (const name of exchange.requestHeaderNames) {
    if (UNCOMPARED_HEADERS.has(name) || name === 'content-type') continue;
    headers[name] = headerValue(name, app, exchange.op);
  }
  return headers;
}

function headerValue(name: string, app: CaptureMApp, op: string): Json {
  if (name === 'x-goog-api-key') return CAPTURE_M_API_KEYS[app];
  if (name === 'x-goog-firebase-installations-auth') return { $: 'fisAuthToken' };
  if (name === 'authorization') throw new Error(`capture M: the SDK operation ${op} sent an Authorization header, which the replay cannot check`);
  return { $: 'any' };
}

/** A body with every recorded key path and any value, or none when the request sent no keys. */
function bodyOf(keys: string[]): JsonObject | undefined {
  if (keys.length === 0) return undefined;
  const body: JsonObject = {};
  const parents = new Set(keys.flatMap((key) => key.split('.').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('.'))));
  for (const key of keys) {
    const parts = key.split('.');
    let at = body;
    for (const part of parts.slice(0, -1)) at = at[part] as JsonObject;
    at[parts.at(-1)!] = parents.has(key) ? {} : { $: 'any' };
  }
  return body;
}

/** The recorded answer with each server-issued value a placeholder and every other capture placeholder a test value. */
function answerOf(value: Json, placeholders: (text: string) => string): Json {
  if (Array.isArray(value)) return value.map((item) => answerOf(item, placeholders));
  if (typeof value === 'string') return issuedOrText(value, placeholders);
  const isObject = typeof value === 'object' && value !== null;
  if (!isObject) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, answerOf(item, placeholders)]));
}

function issuedOrText(text: string, placeholders: (text: string) => string): Json {
  const issued = ISSUED.exec(text);
  if (!issued) return placeholders(text);
  const prefix = placeholders(text.slice(0, issued.index));
  const name = ISSUED_PLACEHOLDER[issued[1]!]!;
  return prefix ? { $: name, prefix } : { $: name };
}

/** The test value for each capture placeholder a converted exchange may hold. */
function testValues(project: string): Record<string, string> {
  return {
    project,
    'sender-id': CAPTURE_M_SENDER_ID,
    'vapid-key': CAPTURE_M_VAPID_KEY,
    'push-endpoint': CAPTURE_M_PUSH_SUBSCRIPTION.endpoint,
    'push-p256dh': CAPTURE_M_PUSH_SUBSCRIPTION.p256dh,
    'push-auth': CAPTURE_M_PUSH_SUBSCRIPTION.auth,
  };
}

/** `text` with every capture placeholder a test value. Throws on one it has no value for. */
function substitute(text: string, project: string): string {
  const values = testValues(project);
  return text.replace(/<([a-z0-9-]+?)(?:-\d+)?>/g, (whole, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`capture M: no test value for ${whole}`);
    return value;
  });
}
