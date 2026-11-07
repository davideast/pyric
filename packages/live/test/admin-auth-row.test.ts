/**
 * The Admin Auth row over the real `firebase-admin/auth` against the
 * replay's in-process server (`test/apps/replay/admin-auth.ts`), through the
 * SDK's own `FIREBASE_AUTH_EMULATOR_HOST`. Every call crosses real HTTP and
 * gets the answers `fixtures/admin-minimal.json` holds. Each record must name
 * `Auth.<method>`, carry `sdk: 'admin'`, production's code, and the account
 * the contract gives it: the decoded token's uid and claim names on
 * `verifyIdToken`, the target uid on user management, none on `listUsers`.
 * No record carries a token, password, email or claim value. An app on
 * another project, set or worked out, is refused by the project gate before
 * any request.
 *
 * Run it with the network off: `unshare -rn sh -c 'ip link set lo up && bun test packages/live/test/admin-auth-row.test.ts'`.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { observedCallOf } from '../src/page-observer.js';
import { adminProjectGate } from '../src/admin/project-gate.js';
import { ADMIN_AUTH_MODULE, observeAdminAuth } from '../src/admin/auth.js';
import type { LiveCallRecord, LiveObserver } from '../src/observe.js';

/** The replay server `test/apps/replay/server.ts` starts: the part this test reads. */
interface ReplayServer {
  readonly origin: string;
  readonly unmatched: unknown[];
  readonly received: unknown[];
  close(): Promise<void>;
}

/** The replay helpers this test uses, loaded at run time: they import their siblings with a `.ts` extension this package's typecheck does not take. */
interface Replay {
  readRecording(path: string): object;
  startReplayServer(recordings: object[]): Promise<ReplayServer>;
}

async function loadReplay(): Promise<Replay> {
  const load = (name: string) => import(new URL(`../../../test/apps/replay/${name}.ts`, import.meta.url).href);
  const [format, server] = await Promise.all([load('format'), load('server')]);
  return { ...format, ...server } as Replay;
}

const PROJECT = 'pyric-replay-admin';
const FIXTURE = new URL('../../../test/apps/replay/fixtures/admin-minimal.json', import.meta.url).pathname;
const EMAIL = 'a@example.com';
const PASSWORD = 'test-password';

type AnyFunction = (...args: unknown[]) => unknown;
type Auth = Record<string, AnyFunction>;
interface AdminAppModule {
  initializeApp(options: object, name: string): object;
}

const fromHere = createRequire(import.meta.url);
const AUTH_ENTRY = fromHere.resolve('firebase-admin/auth');
const baseAuthModule = createRequire(AUTH_ENTRY)('./base-auth') as { BaseAuth: { prototype: Record<string, AnyFunction> } };
const realGetUser = baseAuthModule.BaseAuth.prototype.getUser!;
const { initializeApp } = fromHere('firebase-admin/app') as AdminAppModule;
const { getAuth } = fromHere('firebase-admin/auth') as { getAuth(app: object): Auth };

const records: LiveCallRecord[] = [];
const lines: string[] = [];
const observer: LiveObserver = (record) => {
  records.push(record);
};
let server: ReplayServer;
let auth: Auth;

/** An unsigned ID token, as the Auth emulator issues one, for `uid` with the given extra claims. */
function emulatorToken(uid: string, extra: Record<string, unknown> = {}): string {
  const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, auth_time: now, user_id: uid, sub: uid, iat: now, exp: now + 3600,
    email: EMAIL, firebase: { identities: { email: [EMAIL] }, sign_in_provider: 'password' }, ...extra,
  };
  return `${segment({ alg: 'none', typ: 'JWT' })}.${segment(claims)}.`;
}

beforeAll(async () => {
  const replay = await loadReplay();
  server = await replay.startReplayServer([replay.readRecording(FIXTURE)]);
  process.env.FIREBASE_AUTH_EMULATOR_HOST = new URL(server.origin).host;
  observeAdminAuth(baseAuthModule, { observer, gate: adminProjectGate(PROJECT, (line) => lines.push(line), {}), hostProjectId: PROJECT });
  auth = getAuth(initializeApp({ projectId: PROJECT }, 'admin-auth-row'));
});

afterAll(async () => {
  await server?.close();
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
});

/** The records made since `from`, once the microtasks that make them have run. */
async function recordsSince(from: number): Promise<LiveCallRecord[]> {
  await new Promise((done) => setTimeout(done, 10));
  return records.slice(from);
}

function codeOf(pending: unknown): Promise<unknown> {
  return (pending as Promise<unknown>).then(() => 'ok', (error: { code?: unknown }) => error.code);
}

function summary(made: readonly LiveCallRecord[]) {
  return made.map(({ name, outcome, code, account }) => ({ name, outcome, code, account }));
}

test('the patched method keeps its name and length, and patching twice changes nothing', () => {
  const patched = baseAuthModule.BaseAuth.prototype.getUser!;
  expect(patched).not.toBe(realGetUser);
  expect(patched.name).toBe(realGetUser.name);
  expect(patched.length).toBe(realGetUser.length);
  observeAdminAuth(baseAuthModule, { observer, gate: adminProjectGate(PROJECT, () => undefined, {}), hostProjectId: PROJECT });
  expect(baseAuthModule.BaseAuth.prototype.getUser).toBe(patched);
});

test('an app on another project is refused by the gate before any request, with no record', async () => {
  const from = records.length;
  const sent = server.received.length;
  const other = getAuth(initializeApp({ projectId: 'other-project' }, 'admin-auth-other'));
  expect(await codeOf(other.getUser!('user-a'))).toBe('PYRIC_LIVE_REFUSED');
  expect(await codeOf(other.verifyIdToken!(emulatorToken('user-a')))).toBe('PYRIC_LIVE_REFUSED');
  expect(await recordsSince(from)).toEqual([]);
  expect(server.received.length).toBe(sent);
  expect(lines).toHaveLength(1);
});

test('an app with no project is gated on the project it works out', async () => {
  const from = records.length;
  const sent = server.received.length;
  const before = process.env.GOOGLE_CLOUD_PROJECT;
  process.env.GOOGLE_CLOUD_PROJECT = 'other-prod';
  try {
    const unnamed = getAuth(initializeApp({}, 'admin-auth-unnamed'));
    expect(await codeOf(unnamed.getUser!('user-a'))).toBe('PYRIC_LIVE_REFUSED');
  } finally {
    if (before === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
    else process.env.GOOGLE_CLOUD_PROJECT = before;
  }
  expect(await recordsSince(from)).toEqual([]);
  expect(server.received.length).toBe(sent);
});

test('user management records the target uid, verifyIdToken the token uid and claim names, listUsers no account', async () => {
  const from = records.length;
  const created = (await auth.createUser!({ uid: 'user-a', email: EMAIL, password: PASSWORD })) as { uid: string };
  expect(created.uid).toBe('user-a');
  await auth.getUser!('user-a');
  expect(((await auth.getUserByEmail!(EMAIL)) as { uid: string }).uid).toBe('user-a');
  await auth.setCustomUserClaims!('user-a', { role: 'capture' });
  await auth.updateUser!('user-a', { displayName: 'Capture' });
  const decoded = (await auth.verifyIdToken!(emulatorToken('user-a'), true)) as { uid: string };
  expect(decoded.uid).toBe('user-a');
  const listed = (await auth.listUsers!()) as { users: { uid: string }[] };
  expect(listed.users.map((user) => user.uid)).toEqual(['user-a']);
  expect(((await auth.deleteUsers!(['user-b', 'user-c'])) as { successCount: number }).successCount).toBe(2);
  await auth.deleteUser!('user-a');
  expect(await codeOf(auth.getUser!('user-a'))).toBe('auth/user-not-found');

  const target = { uid: 'user-a' };
  const tokenClaims = { uid: 'user-a', claimNames: ['aud', 'auth_time', 'email', 'exp', 'firebase', 'iat', 'iss', 'sub', 'user_id'] };
  expect(summary(await recordsSince(from))).toEqual([
    { name: 'Auth.createUser', outcome: 'resolved', code: undefined, account: target },
    { name: 'Auth.getUser', outcome: 'resolved', code: undefined, account: target },
    { name: 'Auth.getUserByEmail', outcome: 'resolved', code: undefined, account: target },
    { name: 'Auth.setCustomUserClaims', outcome: 'resolved', code: undefined, account: target },
    { name: 'Auth.updateUser', outcome: 'resolved', code: undefined, account: target },
    { name: 'Auth.verifyIdToken', outcome: 'resolved', code: undefined, account: tokenClaims },
    { name: 'Auth.listUsers', outcome: 'resolved', code: undefined, account: undefined },
    { name: 'Auth.deleteUsers', outcome: 'resolved', code: undefined, account: undefined },
    { name: 'Auth.deleteUser', outcome: 'resolved', code: undefined, account: target },
    { name: 'Auth.getUser', outcome: 'rejected', code: 'auth/user-not-found', account: target },
  ]);
  expect(server.unmatched).toEqual([]);
});

test('each record maps to an Admin auth call, with the uid and claim names only', () => {
  const verified = records.find((record) => record.name === 'Auth.verifyIdToken')!;
  expect(verified).toMatchObject({ module: ADMIN_AUTH_MODULE, sdk: 'admin', projectId: PROJECT });
  expect(observedCallOf(verified, 1)).toMatchObject({ service: 'auth', sdk: 'admin', method: 'Auth.verifyIdToken', outcome: { status: 'ok' }, account: { uid: 'user-a' } });
  const missing = records.at(-1)!;
  expect(observedCallOf(missing, 1)?.outcome).toEqual({ status: 'error', code: 'auth/user-not-found' });
});

test('no record carries a token, password, email or claim value, and nested SDK calls make no record', () => {
  const text = JSON.stringify(records);
  for (const secret of [EMAIL, PASSWORD, emulatorToken('user-a').split('.')[1]!, 'capture', 'Capture']) expect(text).not.toContain(secret);
  expect(records.some((record) => record.account?.claims !== undefined)).toBe(false);
  expect(records.filter((record) => record.name === 'Auth.getUser')).toHaveLength(2);
});

/** A token shaped as a pyric sandbox mints one: RS256 under the sandbox key id, with a securetoken issuer. Unsigned: only its issuer is read. */
function sandboxToken(uid: string): string {
  const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, auth_time: now, user_id: uid, sub: uid, iat: now, exp: now + 3600 };
  return `${segment({ alg: 'RS256', kid: 'pyric-sandbox', typ: 'JWT' })}.${segment(claims)}.c2lnbmF0dXJl`;
}

test('a sandbox-issued token is refused by name at verifyIdToken and verifySessionCookie, with no request or record', async () => {
  const from = records.length;
  const sent = server.received.length;
  for (const method of ['verifyIdToken', 'verifySessionCookie']) {
    const error = (await (auth[method]!(sandboxToken('user-a')) as Promise<unknown>).catch((reason: unknown) => reason)) as { code?: unknown; pyricCode?: unknown; message?: unknown };
    expect({ code: error.code, pyricCode: error.pyricCode }).toEqual({ code: 'auth/argument-error', pyricCode: 'PYRIC_MODE_MISMATCH' });
    expect(String(error.message)).toContain(`live mode for ${PROJECT}`);
  }
  expect(await recordsSince(from)).toEqual([]);
  expect(server.received.length).toBe(sent);
});
