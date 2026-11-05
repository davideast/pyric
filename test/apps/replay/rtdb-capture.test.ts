/**
 * Capture A replays end to end: on the default instance and on a named one,
 * two clients of the real `@firebase/database` web SDK run the sequence the
 * capture recorded against production (set, get, update, push, an
 * uncontended transaction, onValue and onChildAdded with the second client's
 * writes, a denied read and write of /secret, and onDisconnect read back by
 * the second client), answered from capture A as `rtdb-capture.ts` converts
 * it. Every frame the server sends on each connection must equal the frames
 * that connection received in the capture, apart from the values a server
 * picks (handshake host, session and time; token times) and the push keys,
 * which are the ones these clients picked.
 *
 * Auth answers an identical request with the first recording, so each client
 * signs in with its own custom token; the ID token it gets is anonymous, as
 * capture A's clients' were.
 * Run it with the network off: `unshare -rn sh -c 'ip link set lo up && bun test test/apps/replay/rtdb-capture.test.ts'`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import type { Database, DataSnapshot } from 'firebase/database';
import { ReplayState } from './firestore.ts';
import { FORMAT, type AuthExchange, type JsonObject, type Recording } from './format.ts';
import { CAPTURE_RUN, captureInstance, capturePushKeys, captureText, loadCaptureA, readCapture } from './rtdb-capture.ts';
import { routeFirebaseTo } from './seam.ts';
import { refuseUpgrade, startReplayServer, type ReplayServer } from './server.ts';

const PROJECT = 'demo-replay-rtdb';
const CONFIG = { projectId: PROJECT, apiKey: 'test-api-key', appId: '1:1:web:replay', authDomain: `${PROJECT}.firebaseapp.com` };
const RUN_PATH = `pyric-live-capture/${CAPTURE_RUN}`;
const LABELS = ['default', 'named'] as const;
const TIMEOUT_MS = 15_000;

type FirebaseApp = typeof import('firebase/app');
type FirebaseAuth = typeof import('firebase/auth');
type FirebaseDatabase = typeof import('firebase/database');

/** `@firebase/database`'s browser ESM build, found next to the Node build that `firebase/database` resolves to. */
function databaseBrowserEntry(): string {
  const firebaseDatabase = createRequire(import.meta.url).resolve('firebase/database');
  const nodeEntry = createRequire(firebaseDatabase).resolve('@firebase/database');
  return join(dirname(nodeEntry), 'index.esm.js');
}

/** Custom-token sign-ins that each mint an anonymous ID token for `user-N`, the uid capture A's `<uid-N>` becomes. */
function signIns(count: number): Recording {
  const exchanges: AuthExchange[] = [];
  for (let n = 1; n <= count; n++) {
    const uid = `user-${n}`;
    exchanges.push({
      kind: 'auth',
      id: `sign-in-${n}`,
      request: { method: 'POST', host: 'identitytoolkit.googleapis.com', path: '/v1/accounts:signInWithCustomToken', body: { token: `client-${n}`, returnSecureToken: true } },
      response: { status: 200, body: { kind: 'identitytoolkit#VerifyCustomTokenResponse', idToken: { $: 'idToken', uid, provider: 'anonymous' }, refreshToken: { $: 'refreshToken' }, expiresIn: '3600', isNewUser: true } },
    });
    exchanges.push({
      kind: 'auth',
      id: `lookup-${n}`,
      request: { method: 'POST', host: 'identitytoolkit.googleapis.com', path: '/v1/accounts:lookup', body: { idToken: { $: 'idToken', uid } } },
      response: { status: 200, body: { kind: 'identitytoolkit#GetAccountInfoResponse', users: [{ localId: uid, lastLoginAt: '1793907850000', createdAt: '1793907850000' }] } },
    });
  }
  return { format: FORMAT, project: PROJECT, source: 'hand-written from the Auth REST v1 wire format', exchanges };
}

let server: ReplayServer;
let stopRouting: () => void;
let port: number;
let firebase: FirebaseApp;
let auth: FirebaseAuth;
let rtdb: FirebaseDatabase;

beforeAll(async () => {
  server = await startReplayServer([loadCaptureA(PROJECT), signIns(4)]);
  port = Number(new URL(server.origin).port);
  stopRouting = routeFirebaseTo(server.origin);
  firebase = (await import('firebase/app')) as FirebaseApp;
  auth = (await import('firebase/auth')) as FirebaseAuth;
  rtdb = (await import(pathToFileURL(databaseBrowserEntry()).href)) as FirebaseDatabase;
});

afterAll(async () => {
  for (const app of firebase.getApps()) await firebase.deleteApp(app);
  stopRouting();
  await server.close();
});

beforeEach(() => {
  server.unmatched.length = 0;
});

/** Client `n` on one instance: its own app, signed in as `user-n`, pointed at the replay server. */
async function client(label: string, n: number): Promise<Database> {
  const app = firebase.initializeApp(CONFIG, `capture-a-${label}-${n}`);
  const appAuth = auth.getAuth(app);
  auth.connectAuthEmulator(appAuth, server.origin, { disableWarnings: true });
  await auth.signInWithCustomToken(appAuth, `client-${n}`);
  const db = rtdb.getDatabase(app, `https://${captureInstance(PROJECT, label)}.firebaseio.com`);
  rtdb.connectDatabaseEmulator(db, '127.0.0.1', port);
  return db;
}

async function until(done: () => boolean): Promise<void> {
  while (!done()) await new Promise((resolve) => setTimeout(resolve, 10));
}

async function connected(db: Database): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = rtdb.onValue(rtdb.ref(db, '.info/connected'), (snapshot) => {
      if (snapshot.val() !== true) return;
      stop();
      resolve();
    });
  });
}

/** Capture A's sequence on one instance, client one driving and client two the other party, as `capture-a-wire.ts` runs it. */
async function drive(one: Database, two: Database): Promise<{ results: Record<string, unknown>; pushed: string[] }> {
  const at = (db: Database, path: string) => rtdb.ref(db, `${RUN_PATH}/${path}`);
  const results: Record<string, unknown> = {};
  const pushed: string[] = [];
  await connected(one);
  await connected(two);
  await rtdb.set(at(one, 'items/a'), { n: 1, s: 'alpha' });
  results.get = (await rtdb.get(at(one, 'items/a'))).val();
  await rtdb.update(at(one, 'items/a'), { n: 2, flag: true });
  pushed.push((await rtdb.push(at(one, 'list'), { v: 1 })).key!);
  const outcome = await rtdb.runTransaction(at(one, 'counter'), (current: number | null) => (current ?? 0) + 1);
  results.runTransaction = { committed: outcome.committed, value: outcome.snapshot.val() };

  const values: unknown[] = [];
  const stopValue = rtdb.onValue(at(one, 'items/a'), (snapshot: DataSnapshot) => { values.push(snapshot.val()); });
  await until(() => values.length === 1);
  await rtdb.set(at(two, 'items/a/n'), 3);
  await until(() => values.length === 2);
  stopValue();
  results.onValue = values;

  const children: string[] = [];
  const stopChild = rtdb.onChildAdded(at(one, 'list'), (snapshot: DataSnapshot) => { children.push(snapshot.key!); });
  await until(() => children.length === 1);
  pushed.push((await rtdb.push(at(two, 'list'), { v: 2 })).key!);
  await until(() => children.length === 2);
  stopChild();
  results.onChildAdded = children;

  results.deniedRead = await rtdb.get(rtdb.ref(one, 'secret')).then(() => 'allowed', (error: Error) => error.message);
  results.deniedWrite = await rtdb.set(rtdb.ref(one, 'secret'), 'x').then(() => 'allowed', (error: Error) => error.message);

  await rtdb.set(at(one, 'presence'), 'online');
  await rtdb.onDisconnect(at(one, 'presence')).set('offline');
  rtdb.goOffline(one);
  results.presence = (await rtdb.get(at(two, 'presence'))).val();
  rtdb.goOffline(two);
  return { results, pushed };
}

const MASK = '<picked by the server>';

/** A frame with the values a server picks masked: the handshake's time, host and session, and an auth reply's token times. */
function masked(frame: JsonObject): JsonObject {
  const copy = structuredClone(frame);
  const inner = copy.d as JsonObject | undefined;
  if (copy.t === 'c' && inner?.t === 'h') Object.assign(inner.d as JsonObject, { ts: MASK, h: MASK, s: MASK });
  const answer = ((inner?.b as JsonObject | undefined)?.d ?? null) as JsonObject | null;
  const authAnswer = typeof answer === 'object' && answer !== null && 'auth' in answer ? answer : null;
  if (authAnswer) {
    authAnswer.expires = MASK;
    Object.assign((authAnswer.auth as JsonObject).token as JsonObject, { exp: MASK, iat: MASK, auth_time: MASK });
  }
  return copy;
}

/** What each capture A connection received, in open order, with its push keys as the ones `pushed` lists in the same order. */
function receivedInCapture(pushed: string[]): JsonObject[][] {
  const capture = readCapture();
  const keys = capturePushKeys(capture);
  const withPushed = (text: string) => keys.reduce((result, key, index) => result.replaceAll(key, pushed[index]!), text);
  return LABELS.flatMap((label) => {
    const instance = capture.instances[label]!;
    return instance.connections.map((connection) => instance.frames
      .filter((frame) => frame.dir === 'received' && frame.connection === connection.id)
      .map((frame) => masked(JSON.parse(withPushed(captureText(frame.data, PROJECT))) as JsonObject)));
  });
}

describe('capture A replays end to end', () => {
  test('two clients on each instance run the capture and get the frames production sent', async () => {
    const pushed: string[] = [];
    for (const [index, label] of LABELS.entries()) {
      const one = await client(label, index * 2 + 1);
      const two = await client(label, index * 2 + 2);
      const run = await drive(one, two);
      pushed.push(...run.pushed);
      expect(run.results).toEqual({
        get: { n: 1, s: 'alpha' },
        runTransaction: { committed: true, value: 1 },
        onValue: [{ flag: true, n: 2, s: 'alpha' }, { flag: true, n: 3, s: 'alpha' }],
        onChildAdded: run.pushed,
        deniedRead: expect.stringContaining('Permission denied'),
        deniedWrite: expect.stringContaining('PERMISSION_DENIED'),
        presence: 'offline',
      });
    }
    expect(server.unmatched).toEqual([]);
    const sent = server.rtdb.map((connection) => connection.sent.map(masked));
    expect(server.rtdb.map((connection) => connection.instance)).toEqual([1, 2, 3, 4].map((n) => captureInstance(PROJECT, n <= 2 ? 'default' : 'named')));
    expect(sent).toEqual(receivedInCapture(pushed));
  }, TIMEOUT_MS);
});

/** A bare WebSocket on the RTDB endpoint, for frames the SDK would not send. */
interface RawConnection {
  request(r: number, a: string, b: JsonObject): void;
  /** Each reply's `b`, by `r`. */
  replies: Map<number, JsonObject>;
  /** Every server-pushed data frame's `d`. */
  pushed: JsonObject[];
  close(): Promise<void>;
}

async function rawConnection(origin: string, instance: string): Promise<RawConnection> {
  const socket = new WebSocket(`${origin.replace('http', 'ws')}/.ws?ns=${instance}&v=5`);
  const replies = new Map<number, JsonObject>();
  const pushed: JsonObject[] = [];
  socket.onmessage = (message) => {
    const frame = JSON.parse(String(message.data)) as JsonObject;
    const data = frame.d as JsonObject;
    if (frame.t !== 'd') return;
    if (typeof data.r === 'number') replies.set(data.r, data.b as JsonObject);
    else pushed.push(data);
  };
  await new Promise((resolve) => { socket.onopen = resolve; });
  return {
    request: (r, a, b) => socket.send(JSON.stringify({ t: 'd', d: { r, a, b } })),
    replies,
    pushed,
    close: () => new Promise<void>((resolve) => {
      socket.onclose = () => resolve();
      socket.close();
    }),
  };
}

describe('RTDB connections outside capture A', () => {
  test('an onDisconnect write releases the frames it caused when its connection closes, not before', async () => {
    const instance = captureInstance(PROJECT, 'default');
    const handshake = { t: 'c', d: { t: 'h', d: { ts: { $: 'serverTime' }, v: '5', h: { $: 'host' }, s: { $: 'session' } } } };
    const presence = { p: '/presence', d: 'offline' };
    const replay = await startReplayServer([{
      format: FORMAT,
      project: PROJECT,
      source: 'hand-written from capture A',
      exchanges: [
        { kind: 'rtdb', id: 'connect', instance, events: [handshake] },
        { kind: 'rtdb', id: 'register', instance, request: { a: 'o', b: presence }, reply: { s: 'ok', d: '' } },
        { kind: 'rtdb', id: 'listen', instance, request: { a: 'q', b: { p: '/presence', h: '' } }, reply: { s: 'ok', d: {} }, later: [{ after: 'register', events: [{ t: 'd', d: { b: { p: 'presence', d: 'offline' }, a: 'd' } }] }] },
      ],
    }]);
    const leaving = await rawConnection(replay.origin, instance);
    const watching = await rawConnection(replay.origin, instance);
    watching.request(1, 'q', { p: '/presence', h: '' });
    leaving.request(1, 'o', presence);
    await until(() => watching.replies.size === 1 && leaving.replies.size === 1);
    const beforeClose = [...watching.pushed];
    await leaving.close();
    await until(() => watching.pushed.length === 1);
    await watching.close();
    await replay.close();
    expect(beforeClose).toEqual([]);
    expect(watching.pushed).toEqual([{ b: { p: 'presence', d: 'offline' }, a: 'd' }]);
    expect(replay.unmatched).toEqual([]);
  }, TIMEOUT_MS);

  test('an auth credential this server did not mint drops the identity the connection had', async () => {
    const replay = await startReplayServer([loadCaptureA(PROJECT), signIns(1)]);
    const signIn = await fetch(`${replay.origin}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken`, { method: 'POST', body: JSON.stringify({ token: 'client-1', returnSecureToken: true }) });
    const { idToken } = (await signIn.json()) as { idToken: string };
    const connection = await rawConnection(replay.origin, captureInstance(PROJECT, 'default'));
    const replies = connection.replies;
    const read = { p: `/${RUN_PATH}/items/a`, q: {} };
    connection.request(1, 'auth', { cred: idToken });
    connection.request(2, 'g', read);
    connection.request(3, 'auth', { cred: 'a-token-from-somewhere-else' });
    connection.request(4, 'g', read);
    await until(() => replies.size === 4);
    await connection.close();
    await replay.close();
    expect(replies.get(1)?.s).toBe('ok');
    expect(replies.get(2)).toEqual({ s: 'ok', d: { n: 1, s: 'alpha' } });
    expect(replies.get(3)?.s).toBe('pyric_replay_no_recording');
    // The get is recorded for user-1 only: after the failed auth the connection has no uid.
    expect(replies.get(4)?.s).toBe('pyric_replay_no_recording');
    expect(replay.unmatched).toEqual([
      { rpc: 'rtdb', as: 'user-1', request: { instance: captureInstance(PROJECT, 'default'), a: 'auth', b: { cred: 'a token this server did not mint' } } },
      { rpc: 'rtdb', as: null, request: { instance: captureInstance(PROJECT, 'default'), a: 'g', b: read } },
    ]);
  }, TIMEOUT_MS);

  test('an upgrade that fails is listed with its reason', () => {
    const state = new ReplayState([]);
    const socket = new PassThrough();
    const request = { method: 'GET', url: `/.ws?ns=${captureInstance(PROJECT, 'default')}&v=5` } as IncomingMessage;
    refuseUpgrade(state, request, socket, new Error("Cannot find package 'ws'"));
    expect(socket.destroyed).toBe(true);
    expect(state.unmatched).toEqual([{ rpc: 'rtdb', as: null, request: { method: 'GET', path: request.url!, error: "Cannot find package 'ws'" } }]);
  });
});
