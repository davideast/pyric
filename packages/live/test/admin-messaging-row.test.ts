/**
 * The Admin Messaging row over the real `firebase-admin/messaging`: it patches
 * `Messaging.prototype` in `lib/messaging/messaging.js`, so `send`,
 * `sendEach`, `sendEachForMulticast`, `subscribeToTopic` and
 * `unsubscribeFromTopic` each pass the project gate and make one record named
 * `Messaging.<method>`, with `sdk: 'admin'`, the project and production's
 * answer. No record carries a registration token, a topic or a message.
 *
 * Every request to FCM or Instance ID goes to a local stand-in, in plain
 * HTTP with its Google host kept: the test wraps `https.request` while it
 * runs, since Bun ignores an Agent's `createConnection`. The app uses
 * firebase-admin's HTTP/1 transport, so `sendEach` takes `https.request`
 * too. Run it with the network off:
 * `unshare -rn sh -c 'ip link set lo up && bun test packages/live/test/admin-messaging-row.test.ts'`.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import http, { createServer, type Server } from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { observedCallOf } from '../src/page-observer.js';
import { adminProjectGate } from '../src/admin/project-gate.js';
import { ADMIN_MESSAGING_MODULE, observeAdminMessaging } from '../src/admin/messaging.js';
import type { LiveCallRecord, LiveObserver } from '../src/observe.js';

const PROJECT = 'demo-admin-messaging';
const TOKEN_A = 'fcm-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_B = 'fcm-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TOPIC = 'order-updates';

type AnyFunction = (...args: unknown[]) => unknown;
type Messaging = Record<string, AnyFunction>;

const fromHere = createRequire(import.meta.url);
const messagingModule = createRequire(fromHere.resolve('firebase-admin/messaging'))('./messaging') as { Messaging: { prototype: Record<string, AnyFunction> } };
const realSend = messagingModule.Messaging.prototype.send!;
const { initializeApp } = fromHere('firebase-admin/app') as { initializeApp(options: object, name: string): object };
const { getMessaging } = fromHere('firebase-admin/messaging') as { getMessaging(app: object): Messaging };

const records: LiveCallRecord[] = [];
const lines: string[] = [];
const observer: LiveObserver = (record) => {
  records.push(record);
};
/** The paths FCM's stand-in received. */
const received: string[] = [];
let stand: Server;
let messaging: Messaging;
const realRequest = https.request;

/** The hosts the stand-in answers for. */
const STAND_IN_HOSTS = new Set(['fcm.googleapis.com', 'iid.googleapis.com']);

/** `https.request` that sends a request for an FCM or Instance ID host to the stand-in on `port`, keeping its host header. */
function toStandIn(port: number): typeof https.request {
  return ((options: https.RequestOptions, callback?: (response: http.IncomingMessage) => void) => {
    const host = options.hostname ?? options.host ?? '';
    if (!STAND_IN_HOSTS.has(host)) return realRequest(options, callback);
    const headers = { ...(options.headers ?? {}), host };
    return http.request({ ...options, protocol: 'http:', host: '127.0.0.1', hostname: '127.0.0.1', port, agent: undefined, headers }, callback);
  }) as typeof https.request;
}

const credential = { getAccessToken: async () => ({ access_token: 'stand-in-access-token', expires_in: 3600 }) };

function appFor(projectId: string, name: string): Messaging {
  const app = initializeApp({ projectId, credential }, name);
  const made = getMessaging(app);
  (made.enableLegacyHttpTransport as AnyFunction).call(made);
  return made;
}

beforeAll(async () => {
  stand = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const path = request.url ?? '';
      received.push(path);
      const isSend = path.endsWith('/messages:send');
      const body = isSend ? { name: `projects/${PROJECT}/messages/1` } : { results: [{}, {}] };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((done) => stand.listen(0, '127.0.0.1', done));
  const { port } = stand.address() as AddressInfo;
  https.request = toStandIn(port);
  observeAdminMessaging(messagingModule, { observer, gate: adminProjectGate(PROJECT, (line) => lines.push(line), {}) });
  messaging = appFor(PROJECT, 'admin-messaging-row');
});

afterAll(async () => {
  https.request = realRequest;
  await new Promise((done) => stand?.close(done));
});

async function recordsSince(from: number): Promise<LiveCallRecord[]> {
  await new Promise((done) => setTimeout(done, 10));
  return records.slice(from);
}

function codeOf(pending: unknown): Promise<unknown> {
  return (pending as Promise<unknown>).then(() => 'ok', (error: { code?: unknown }) => error.code);
}

test('the patched method keeps its name and length, and patching twice changes nothing', () => {
  const patched = messagingModule.Messaging.prototype.send!;
  expect(patched).not.toBe(realSend);
  expect(patched.name).toBe(realSend.name);
  expect(patched.length).toBe(realSend.length);
  observeAdminMessaging(messagingModule, { observer, gate: adminProjectGate(PROJECT, () => undefined, {}) });
  expect(messagingModule.Messaging.prototype.send).toBe(patched);
});

test('each send and topic call makes one record, with the project and production answer', async () => {
  const from = records.length;
  const outcomes = [
    await codeOf(messaging.send!({ token: TOKEN_A, notification: { title: 'Order shipped' } })),
    await codeOf(messaging.sendEach!([{ token: TOKEN_A, data: { order: '1' } }, { token: TOKEN_B, data: { order: '2' } }])),
    await codeOf(messaging.sendEachForMulticast!({ tokens: [TOKEN_A, TOKEN_B], data: { order: '3' } })),
    await codeOf(messaging.subscribeToTopic!([TOKEN_A, TOKEN_B], TOPIC)),
    await codeOf(messaging.unsubscribeFromTopic!(TOKEN_A, TOPIC)),
  ];
  expect(outcomes).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
  const made = await recordsSince(from);
  expect(made.map(({ module, name, outcome, sdk, projectId }) => ({ module, name, outcome, sdk, projectId }))).toEqual(
    ['send', 'sendEach', 'sendEachForMulticast', 'subscribeToTopic', 'unsubscribeFromTopic'].map((method) => ({
      module: ADMIN_MESSAGING_MODULE,
      name: `Messaging.${method}`,
      outcome: 'resolved',
      sdk: 'admin',
      projectId: PROJECT,
    })),
  );
  // No record carries a token, a topic or the message.
  const text = JSON.stringify(made);
  for (const secret of [TOKEN_A, TOKEN_B, TOPIC, 'Order shipped', 'stand-in-access-token']) expect(text).not.toContain(secret);
});

test('a Messaging whose app the row cannot read is refused before any request', async () => {
  // Stands in for a firebase-admin whose Messaging no longer answers its public app getter.
  const unread = Object.create(messagingModule.Messaging.prototype) as Messaging;
  Object.defineProperty(unread, 'app', { value: undefined });
  const sent = received.length;
  expect(await codeOf(unread.send!({ token: TOKEN_A }))).toBe('PYRIC_LIVE_REFUSED');
  expect(await codeOf(unread.subscribeToTopic!(TOKEN_A, TOPIC))).toBe('PYRIC_LIVE_REFUSED');
  expect(received.length).toBe(sent);
});

test('each record maps to an Admin messaging call', async () => {
  const from = records.length;
  await codeOf(messaging.send!({ token: TOKEN_A }));
  const [record] = await recordsSince(from);
  expect(observedCallOf(record!, 5)).toEqual({ service: 'messaging', sdk: 'admin', method: 'Messaging.send', at: 5, outcome: { status: 'ok' }, projectId: PROJECT });
});

test('an app on another project is refused by the gate before any request, with no record', async () => {
  const from = records.length;
  const sent = received.length;
  const other = appFor('other-project', 'admin-messaging-other');
  const outcomes = [
    await codeOf(other.send!({ token: TOKEN_A })),
    await codeOf(other.sendEachForMulticast!({ tokens: [TOKEN_A] })),
    await codeOf(other.subscribeToTopic!(TOKEN_A, TOPIC)),
  ];
  expect(outcomes).toEqual(['PYRIC_LIVE_REFUSED', 'PYRIC_LIVE_REFUSED', 'PYRIC_LIVE_REFUSED']);
  expect(await recordsSince(from)).toEqual([]);
  expect(received.length).toBe(sent);
  expect(lines).toHaveLength(1);
});
