/**
 * The Node build of the real `firebase/database` SDK, which connects with
 * faye-websocket, runs part of capture A in a `node` process of its own
 * against a replay server process (`startReplayProcess` with
 * `rtdbCapture`): two clients sign in, the first sets, gets and listens to a
 * value the second writes, then reads the denied `/secret`. The SDK's
 * emulator connectors point it at the server, as an app's config does.
 * `/__replay/received` lists the frames the clients sent, and an upgrade the
 * server refuses (an instance no recording holds) is listed in `unmatched`.
 * Run it with the network off: `unshare -rn sh -c 'ip link set lo up && bun test test/apps/replay/rtdb-node.test.ts'`.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FORMAT, type AuthExchange, type JsonObject, type Recording } from './format.ts';
import { receivedBy, startReplayProcess, unmatchedBy, type ReplayProcess } from './process.ts';
import { CAPTURE_RUN, captureInstance } from './rtdb-capture.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const PROJECT = 'demo-replay-rtdb';
const INSTANCE = captureInstance(PROJECT, 'default');
const RUN_PATH = `/pyric-live-capture/${CAPTURE_RUN}`;

/** Custom-token sign-ins: `client-N` gets an anonymous ID token for `user-N`, the uid capture A's `<uid-N>` becomes. */
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

/**
 * Plain Node app code: two apps sign in with custom tokens and run capture
 * A's set, get, onValue with the second client's write, and denied read on
 * the default instance. It prints one `RESULT` line.
 */
const CLIENT = `
import { deleteApp, initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithCustomToken } from 'firebase/auth';
import { connectDatabaseEmulator, get, getDatabase, onValue, ref, set } from 'firebase/database';

const [origin, project, instance, run] = process.argv.slice(1);
const port = Number(new URL(origin).port);
const config = { projectId: project, apiKey: 'test-api-key', appId: '1:1:web:replay', databaseURL: 'https://' + instance + '.firebaseio.com' };

async function client(n) {
  const app = initializeApp(config, 'client-' + n);
  const auth = getAuth(app);
  connectAuthEmulator(auth, origin, { disableWarnings: true });
  const user = await signInWithCustomToken(auth, 'client-' + n);
  const db = getDatabase(app);
  connectDatabaseEmulator(db, '127.0.0.1', port);
  return { app, db, uid: user.user.uid };
}

const one = await client(1);
const two = await client(2);
const at = (db, path) => ref(db, run + '/' + path);
const result = { uids: [one.uid, two.uid] };
await set(at(one.db, 'items/a'), { n: 1, s: 'alpha' });
result.get = (await get(at(one.db, 'items/a'))).val();
const values = [];
let stop = () => {};
const changed = new Promise((resolve) => {
  stop = onValue(at(one.db, 'items/a'), (snapshot) => {
    values.push(snapshot.val());
    if (values.length === 2) resolve();
  });
});
await new Promise((resolve) => setTimeout(resolve, 200));
await set(at(two.db, 'items/a/n'), 3);
await changed;
stop();
result.onValue = values;
result.deniedRead = await get(ref(one.db, 'secret')).then(() => 'allowed', (error) => error.message);
await deleteApp(one.app);
await deleteApp(two.app);
console.log('RESULT ' + JSON.stringify(result));
process.exit(0);
`;

let server: ReplayProcess;
let scratch: string;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'pyric-rtdb-node-'));
  const recording = join(scratch, 'sign-ins.json');
  writeFileSync(recording, JSON.stringify(signIns(2)));
  server = await startReplayProcess([recording], undefined, { rtdbCapture: PROJECT });
});

afterAll(async () => {
  await server?.stop();
  rmSync(scratch, { recursive: true, force: true });
});

/** Runs the client under `node` from the repository root, so `firebase` resolves to its Node build. */
function runClient(): Promise<{ stdout: string; stderr: string }> {
  return new Promise((done) => {
    const args = ['--input-type=module', '-e', CLIENT, server.origin, PROJECT, INSTANCE, RUN_PATH];
    const child = spawn('node', args, { cwd: ROOT, timeout: 60_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (part: Buffer) => { stdout += part.toString(); });
    child.stderr.on('data', (part: Buffer) => { stderr += part.toString(); });
    child.on('close', () => done({ stdout, stderr }));
  });
}

/** The action and path of each data frame the server received, as `<a> <p>`. */
function requests(frames: JsonObject[]): string[] {
  return frames.flatMap((frame) => {
    const data = frame.t === 'd' ? (frame.d as JsonObject) : null;
    const path = (data?.b as JsonObject | undefined)?.p;
    return data ? [`${String(data.a)}${typeof path === 'string' ? ` ${path}` : ''}`] : [];
  });
}

test('the Node SDK signs in, sets, gets, listens to a second client and is denied /secret, answered from capture A', async () => {
  const run = await runClient();
  const line = run.stdout.split('\n').find((entry) => entry.startsWith('RESULT '));
  expect(line, `${run.stdout}\n${run.stderr}`).toBeDefined();
  expect(JSON.parse(line!.slice('RESULT '.length))).toEqual({
    uids: ['user-1', 'user-2'],
    get: { n: 1, s: 'alpha' },
    // Capture A's listen started after its update, so the replayed value carries `flag`.
    onValue: [{ flag: true, n: 2, s: 'alpha' }, { flag: true, n: 3, s: 'alpha' }],
    deniedRead: expect.stringContaining('Permission denied'),
  });
  expect(await unmatchedBy(server.origin)).toEqual([]);

  const received = (await receivedBy(server.origin)).filter((entry) => entry.rpc === 'rtdb');
  const byUid = (uid: string | null) => requests(received.filter((entry) => entry.as === uid).map((entry) => (entry.message as JsonObject).frame as JsonObject));
  expect(received.every((entry) => (entry.message as JsonObject).instance === INSTANCE)).toBe(true);
  // Before `auth` answers, a connection has no uid: its stats and `auth` frames are listed as null's.
  expect(byUid(null)).toEqual(['s', 'auth', 's', 'auth']);
  expect(byUid('user-1')).toEqual([`p ${RUN_PATH}/items/a`, `g ${RUN_PATH}/items/a`, `q ${RUN_PATH}/items/a`, `n ${RUN_PATH}/items/a`, 'g /secret']);
  expect(byUid('user-2')).toEqual([`p ${RUN_PATH}/items/a/n`]);
}, 90_000);

test('an RTDB upgrade for an instance no recording holds is listed in unmatched', async () => {
  const before = (await unmatchedBy(server.origin)).length;
  const socket = new WebSocket(`${server.origin.replace('http', 'ws')}/.ws?ns=not-a-recorded-instance&v=5`);
  await new Promise((done) => { socket.onclose = done; });
  const unmatched = (await unmatchedBy(server.origin)).slice(before);
  expect(unmatched).toEqual([{ rpc: 'rtdb', as: null, request: { instance: 'not-a-recorded-instance' } }]);
}, 15_000);
