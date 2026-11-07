/**
 * The Admin RTDB row over the real `@firebase/database-compat/standalone`,
 * the copy firebase-admin loads, against the replay server's RTDB WebSocket
 * (`test/apps/replay/rtdb.ts`) through the SDK's own
 * `FIREBASE_DATABASE_EMULATOR_HOST`. The connection authenticates with
 * `gauth` as `owner`, and every answer comes from
 * `fixtures/admin-minimal.json` or the exchanges below. Each record must name
 * the class and method, the path, the instance, `sdk: 'admin'` and
 * production's status, and carry no data value or credential. An app on
 * another project, named by its options or worked out by its credential, is
 * refused by the project gate before any request.
 *
 * Run it with the network off: `unshare -rn sh -c 'ip link set lo up && bun test packages/live/test/admin-database-row.test.ts'`.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { observedCallOf } from '../src/page-observer.js';
import { adminProjectGate } from '../src/admin/project-gate.js';
import { ADMIN_DATABASE_MODULE, observeAdminDatabase } from '../src/admin/database.js';
import { firebaseAdminVersion } from '../src/admin/admin-version.js';
import type { LiveCallRecord, LiveObserver } from '../src/observe.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** One frame a client sent, as the replay lists it. */
interface Received {
  readonly rpc: string;
  readonly message?: { readonly instance?: string; readonly frame?: { t?: string; d?: { a?: string; b?: { p?: string } } } };
}

/** The replay server this test starts in process: the part it reads. */
interface ReplayServer {
  readonly origin: string;
  readonly unmatched: unknown[];
  close(): Promise<void>;
}

/** The replay helpers this test uses from `test/apps/replay/`. */
interface Replay {
  readRecording(path: string): object;
  startReplayServer(recordings: object[]): Promise<ReplayServer>;
}

/**
 * Loads the replay helpers at run time. They import their siblings with a
 * `.ts` extension, which this package's typecheck does not take, so they stay
 * out of it and this test declares the part it uses.
 */
async function loadReplay(): Promise<Replay> {
  const load = (name: string) => import(new URL(`../../../test/apps/replay/${name}.ts`, import.meta.url).href);
  const [format, server] = await Promise.all([load('format'), load('server')]);
  return { ...format, ...server } as Replay;
}

const PROJECT = 'pyric-replay-admin';
const INSTANCE = 'pyric-replay-admin-default-rtdb';
const DATABASE_URL = `https://${INSTANCE}.firebaseio.com`;
/** A named instance whose name doesn't start with the project's, as firebase.json's database targets can name one. */
const CONFIGURED_INSTANCE = 'team-ledger';
const FIXTURE = new URL('../../../test/apps/replay/fixtures/admin-minimal.json', import.meta.url).pathname;

/** An exchange answered `ok` with no data, as production answers a write. */
function write(id: string, a: string, b: Json): Json {
  return { kind: 'rtdb', id, instance: INSTANCE, as: 'owner', request: { a, b }, reply: { s: 'ok', d: '' } };
}

/** A listen on `path`: production pushes `data`, then answers `ok`. */
function listen(id: string, path: string, data: Json): Json {
  const event = { t: 'd', d: { a: 'd', b: { p: path, d: data } } };
  return { kind: 'rtdb', id, instance: INSTANCE, as: 'owner', request: { a: 'q', b: { p: path, h: { $: 'any' } } }, events: [event], reply: { s: 'ok', d: {} } };
}

/**
 * The exchanges the fixture does not hold yet (R-4 replaces them from
 * capture A): a listen, a transaction's listen and conditional write, and a
 * write with a priority. Hand-written from the RTDB wire protocol.
 */
const EXTRA = {
  format: 'pyric-replay/1',
  project: PROJECT,
  source: 'hand-written from the RTDB wire protocol for the Admin RTDB row test',
  exchanges: [
    listen('listen-b', '/notes/b', { n: 5, title: 'second' }),
    { ...(write('set-b', 'p', { p: '/notes/b', d: { n: 6, title: 'third' } }) as object), events: [{ t: 'd', d: { a: 'd', b: { p: '/notes/b', d: { n: 6, title: 'third' } } } }] },
    listen('listen-counter', '/counter', 1),
    { kind: 'rtdb', id: 'transaction-stale', instance: INSTANCE, as: 'owner', request: { a: 'p', b: { p: '/counter', d: 1, h: '' } }, reply: { s: 'datastale', d: 'Transaction hash does not match' } },
    write('transaction-counter', 'p', { p: '/counter', d: 2, h: { $: 'any' } }),
    write('set-priority', 'p', { p: '/notes/c', d: { n: 7, '.priority': 1 } }),
  ],
};

type AnyFunction = (...args: unknown[]) => unknown;
type Instance = Record<string, AnyFunction> & Record<string, unknown>;
interface AdminApp {
  delete(): Promise<void>;
}
interface AdminSdk {
  initializeApp(options: object, name: string): AdminApp;
}

const require = createRequire(import.meta.url);
const fromAdmin = createRequire(require.resolve('firebase-admin/database'));
const sdk = fromAdmin('@firebase/database-compat/standalone') as { Reference: { prototype: Record<string, AnyFunction> } };
const admin = require('firebase-admin/app') as AdminSdk;
const { getDatabase } = require('firebase-admin/database') as { getDatabase(app: AdminApp): Instance };
const realSet = sdk.Reference.prototype.set!;
/** The installed firebase-admin's version, read from its own package.json beside `lib/`. */
const ADMIN_VERSION = (JSON.parse(readFileSync(join(dirname(require.resolve('firebase-admin')), '..', 'package.json'), 'utf8')) as { version: string }).version;

const records: LiveCallRecord[] = [];
const lines: string[] = [];
const observer: LiveObserver = (record) => {
  records.push(record);
};
let server: ReplayServer;
let app: AdminApp;
let db: Instance;
const others: AdminApp[] = [];

beforeAll(async () => {
  const replay = await loadReplay();
  server = await replay.startReplayServer([replay.readRecording(FIXTURE), EXTRA]);
  process.env.FIREBASE_DATABASE_EMULATOR_HOST = new URL(server.origin).host;
  observeAdminDatabase(sdk, { observer, gate: adminProjectGate(PROJECT, (line) => lines.push(line), {}), hostProjectId: PROJECT, hostInstances: [CONFIGURED_INSTANCE], adminVersion: ADMIN_VERSION });
  app = admin.initializeApp({ projectId: PROJECT, databaseURL: DATABASE_URL }, 'admin-database-row');
  db = getDatabase(app);
});

afterAll(async () => {
  for (const each of [app, ...others]) await each?.delete();
  await server?.close();
  delete process.env.FIREBASE_DATABASE_EMULATOR_HOST;
});

/** The records made since `from`, once the callbacks that make them have run. */
async function recordsSince(from: number): Promise<LiveCallRecord[]> {
  await new Promise((done) => setTimeout(done, 20));
  return records.slice(from);
}

function ref(path: string, database: Instance = db): Instance {
  return (database.ref as AnyFunction).call(database, path) as Instance;
}

function codeOf(pending: unknown): Promise<unknown> {
  return (pending as Promise<unknown>).then(() => 'ok', (error: { code?: unknown; message?: unknown }) => error.code ?? error.message);
}

/** Every RTDB frame clients sent, as the replay's `/__replay/received` lists them. */
async function received(): Promise<Received[]> {
  const listed = (await (await fetch(`${server.origin}/__replay/received`)).json()) as Received[];
  return listed.filter((entry) => entry.rpc === 'rtdb');
}

/** The data frames clients sent since `from`, leaving out authentication and stats. */
async function requestsSince(from: number): Promise<string[]> {
  const frames = (await received()).slice(from).map((entry) => entry.message?.frame?.d?.a);
  return frames.filter((action): action is string => typeof action === 'string' && !['gauth', 'auth', 's'].includes(action));
}

/** The fields a test compares: what a record says, without the call time. */
function shown(record: LiveCallRecord) {
  const { module, name, outcome, sdk: madeBy, projectId, instance, path, code } = record;
  return { module, name, outcome, sdk: madeBy, projectId, instance, path, ...(code === undefined ? {} : { code }) };
}

test('the patched method keeps its name and length, and patching twice changes nothing', () => {
  const patched = sdk.Reference.prototype.set!;
  expect(patched).not.toBe(realSet);
  expect(patched.name).toBe(realSet.name);
  expect(patched.length).toBe(realSet.length);
  observeAdminDatabase(sdk, { observer, gate: adminProjectGate(PROJECT, () => undefined, {}), hostProjectId: PROJECT });
  expect(sdk.Reference.prototype.set).toBe(patched);
});

test('set, get, update, push and remove each make one record with the path, the instance and ok', async () => {
  const from = records.length;
  const sent = (await received()).length;
  await ref('notes/a').set!({ n: 1, title: 'first' });
  const snapshot = (await ref('notes/a').get!()) as { val(): unknown };
  expect(snapshot.val()).toEqual({ n: 1, title: 'first' });
  await ref('notes/a').update!({ n: 2 });
  const pushed = ref('notes').push!({ n: 3 }) as Instance & Promise<Instance>;
  expect(typeof pushed.key).toBe('string');
  const settled = await pushed;
  expect(settled.key).toBe(pushed.key);
  const missing = (await ref('notes/missing').get!()) as { val(): unknown };
  expect(missing.val()).toBeNull();
  await ref('notes/a').remove!();
  const made = (await recordsSince(from)).map(shown);
  const base = { module: ADMIN_DATABASE_MODULE, outcome: 'resolved' as const, sdk: 'admin' as const, projectId: PROJECT, instance: INSTANCE };
  expect(made).toEqual([
    { ...base, name: 'Reference.set', path: '/notes/a' },
    { ...base, name: 'Query.get', path: '/notes/a' },
    { ...base, name: 'Reference.update', path: '/notes/a' },
    { ...base, name: 'Reference.push', path: '/notes' },
    { ...base, name: 'Query.get', path: '/notes/missing' },
    { ...base, name: 'Reference.remove', path: '/notes/a' },
  ]);
  expect(await requestsSince(sent)).toEqual(['p', 'g', 'm', 'p', 'g', 'p']);
  expect(observedCallOf(records[from]!, 1)).toMatchObject({ service: 'rtdb', sdk: 'admin', method: 'Reference.set', instance: INSTANCE, path: '/notes/a', outcome: { status: 'ok' } });
  expect(server.unmatched).toEqual([]);
});

test('once, setWithPriority and transaction make one record each', async () => {
  const from = records.length;
  const once = (await ref('notes/b').once!('value')) as { val(): unknown };
  expect(once.val()).toEqual({ n: 5, title: 'second' });
  await ref('notes/c').setWithPriority!({ n: 7 }, 1);
  const result = (await ref('counter').transaction!((current: unknown) => (typeof current === 'number' ? current + 1 : 1))) as { committed: boolean; snapshot: { val(): unknown } };
  expect(result.committed).toBe(true);
  expect(result.snapshot.val()).toBe(2);
  const made = (await recordsSince(from)).map(({ name, outcome, path }) => ({ name, outcome, path }));
  expect(made).toEqual([
    { name: 'Query.once', outcome: 'resolved', path: '/notes/b' },
    { name: 'Reference.setWithPriority', outcome: 'resolved', path: '/notes/c' },
    { name: 'Reference.transaction', outcome: 'resolved', path: '/counter' },
  ]);
  expect(server.unmatched).toEqual([]);
});

test('an unrecorded write records production status as its code', async () => {
  const from = records.length;
  const unmatched = server.unmatched.length;
  expect(await codeOf(ref('unrecorded').set!(1))).toBeDefined();
  const made = (await recordsSince(from)).map(shown);
  expect(made).toEqual([{ module: ADMIN_DATABASE_MODULE, name: 'Reference.set', outcome: 'rejected', sdk: 'admin', projectId: PROJECT, instance: INSTANCE, path: '/unrecorded', code: 'pyric_replay_no_recording' }]);
  expect(observedCallOf(records[from]!, 1)?.outcome).toEqual({ status: 'error', code: 'pyric_replay_no_recording' });
  expect(server.unmatched.slice(unmatched)).toEqual([{ rpc: 'rtdb', as: 'owner', request: { instance: INSTANCE, a: 'p', b: { p: '/unrecorded', d: 1 } } }]);
  server.unmatched.splice(unmatched);
});

test('on records each delivery and returns the app callback, and off by that callback stops the deliveries', async () => {
  const from = records.length;
  const target = ref('notes/b');
  const seen: unknown[] = [];
  const callback = (snapshot: { val(): unknown }) => void seen.push(snapshot.val());
  const returned = target.on!('value', callback);
  expect(returned).toBe(callback);
  await new Promise((done) => setTimeout(done, 50));
  await ref('notes/b').set!({ n: 6, title: 'third' });
  await new Promise((done) => setTimeout(done, 20));
  target.off!('value', callback);
  expect(seen).toHaveLength(2);
  const made = (await recordsSince(from)).map(({ name, outcome, path, instance }) => ({ name, outcome, path, instance }));
  expect(made).toEqual([
    { name: 'Query.on', outcome: 'returned', path: '/notes/b', instance: INSTANCE },
    { name: 'Query.on', outcome: 'delivered', path: '/notes/b', instance: INSTANCE },
    { name: 'Query.on', outcome: 'delivered', path: '/notes/b', instance: INSTANCE },
    { name: 'Reference.set', outcome: 'resolved', path: '/notes/b', instance: INSTANCE },
  ]);
  await ref('notes/b').set!({ n: 6, title: 'third' });
  await new Promise((done) => setTimeout(done, 20));
  expect(seen).toHaveLength(2);
  expect(records.slice(from).filter((record) => record.name === 'Query.on').map((record) => observedCallOf(record, 1)?.outcome ?? null)).toEqual([null, { status: 'ok' }, { status: 'ok' }]);
  expect(server.unmatched).toEqual([]);
});

/** The code a call's promise settles with, or the code it throws at once, as `ref()` does on a refused app. */
function refusedCode(call: () => unknown): Promise<unknown> {
  try {
    return codeOf(call());
  } catch (error) {
    return Promise.resolve((error as { code?: unknown }).code);
  }
}

/** Every RTDB frame clients sent since `from`, authentication and stats included, once a connection could have opened. */
async function framesSince(from: number): Promise<Received[]> {
  await new Promise((done) => setTimeout(done, 100));
  return (await received()).slice(from);
}

test('the installed firebase-admin keeps the instance where the gate reads it', () => {
  // The instance gate reads `_delegate._repoInternal.repoInfo_.namespace`. A
  // firebase-admin upgrade that moves it fails here, naming the version.
  const delegate = (db as unknown as { _delegate: { _repoInternal: { repoInfo_: { namespace: unknown } } } })._delegate;
  expect({ version: ADMIN_VERSION, namespace: delegate._repoInternal.repoInfo_.namespace }).toEqual({ version: ADMIN_VERSION, namespace: INSTANCE });
});

test("the register reads firebase-admin's version from the file that loads the Realtime Database SDK", () => {
  expect(firebaseAdminVersion(require.resolve('firebase-admin/database'))).toBe(ADMIN_VERSION);
  expect(firebaseAdminVersion(undefined)).toBeUndefined();
  expect(firebaseAdminVersion('/no/such/place/index.js')).toBeUndefined();
});

test('a Database whose instance the gate cannot read is refused, naming the firebase-admin version, and never connects', async () => {
  const unread = admin.initializeApp({ projectId: PROJECT, databaseURL: DATABASE_URL }, 'admin-database-unread-instance');
  others.push(unread);
  const unreadDb = getDatabase(unread);
  // Stands in for a firebase-admin that keeps the repo somewhere else; the
  // repo goes back at the end, so the app's own delete can find it.
  const delegate = (unreadDb as unknown as { _delegate: object })._delegate;
  const repo: unknown = Reflect.get(delegate, '_repoInternal');
  Object.defineProperty(delegate, '_repoInternal', { value: undefined });
  const from = records.length;
  const sent = (await received()).length;
  let refusal: { code?: unknown; message?: unknown } = {};
  try {
    ref('notes/a', unreadDb);
  } catch (error) {
    refusal = error as typeof refusal;
  }
  expect(refusal.code).toBe('PYRIC_LIVE_REFUSED');
  expect(String(refusal.message)).toContain(`firebase-admin ${ADMIN_VERSION}`);
  expect(await refusedCode(() => ref('notes/a', unreadDb))).toBe('PYRIC_LIVE_REFUSED');
  expect(await recordsSince(from)).toEqual([]);
  expect(await framesSince(sent)).toEqual([]);
  Object.defineProperty(delegate, '_repoInternal', { value: repo });
});

test('an app on another project is refused at ref() and its connection never opens, with no record', async () => {
  const other = admin.initializeApp({ projectId: 'other-project', databaseURL: DATABASE_URL }, 'admin-database-other');
  others.push(other);
  const otherDb = getDatabase(other);
  const from = records.length;
  const sent = (await received()).length;
  expect(await refusedCode(() => ref('notes/a', otherDb))).toBe('PYRIC_LIVE_REFUSED');
  expect(await refusedCode(() => (otherDb.refFromURL as AnyFunction).call(otherDb, `${DATABASE_URL}/notes/a`))).toBe('PYRIC_LIVE_REFUSED');
  expect(await refusedCode(() => ref('notes/a', otherDb).setPriority!(1))).toBe('PYRIC_LIVE_REFUSED');
  expect(await refusedCode(() => (ref('notes/a', otherDb).onDisconnect!() as Instance).set!({ n: 1 }))).toBe('PYRIC_LIVE_REFUSED');
  expect(await refusedCode(() => ref('notes/a', otherDb).get!())).toBe('PYRIC_LIVE_REFUSED');
  expect(await refusedCode(() => ref('notes', otherDb).push!({ n: 1 }))).toBe('PYRIC_LIVE_REFUSED');
  expect(await recordsSince(from)).toEqual([]);
  expect(await framesSince(sent)).toEqual([]);
  expect(server.unmatched).toEqual([]);
  expect(lines).toHaveLength(1);
});

test('an app with no project stays offline until its own credential works out the project, and is refused', async () => {
  const credential = { getAccessToken: async () => ({ access_token: 'not-a-token', expires_in: 3600 }), getProjectId: async () => 'other-prod' };
  const other = admin.initializeApp({ credential, databaseURL: DATABASE_URL }, 'admin-database-adc');
  others.push(other);
  const otherDb = getDatabase(other);
  const from = records.length;
  const sent = (await received()).length;
  const first = ref('notes/a', otherDb);
  void codeOf(first.setPriority!(1));
  void codeOf((first.onDisconnect!() as Instance).set!({ n: 1 }));
  expect(await codeOf(first.get!())).toBe('PYRIC_LIVE_REFUSED');
  const cancelled = await new Promise((done) => first.on!('value', () => done('delivered'), (error: { code?: unknown }) => done(error.code)));
  expect(cancelled).toBe('PYRIC_LIVE_REFUSED');
  expect(await refusedCode(() => ref('notes/a', otherDb))).toBe('PYRIC_LIVE_REFUSED');
  expect(await recordsSince(from)).toEqual([]);
  expect(await framesSince(sent)).toEqual([]);
});

/** A new Admin app whose credential works out `project`, as application default credentials do. */
function credentialApp(name: string, project: string): Instance {
  const credential = { getAccessToken: async () => ({ access_token: 'not-a-token', expires_in: 3600 }), getProjectId: async () => project };
  const made = admin.initializeApp({ credential, databaseURL: DATABASE_URL }, name);
  others.push(made);
  return getDatabase(made);
}

function goOnline(database: Instance): unknown {
  return (database.goOnline as AnyFunction).call(database);
}

function goOffline(database: Instance): unknown {
  return (database.goOffline as AnyFunction).call(database);
}

test('goOnline on an app that names another project is refused and opens no connection', async () => {
  const other = admin.initializeApp({ projectId: 'other-project-3', databaseURL: DATABASE_URL }, 'admin-database-online-other');
  others.push(other);
  const otherDb = getDatabase(other);
  const sent = (await received()).length;
  expect(await refusedCode(() => goOnline(otherDb))).toBe('PYRIC_LIVE_REFUSED');
  expect(await framesSince(sent)).toEqual([]);
});

test('goOnline while the gate is still working out the project does not resume the connection', async () => {
  const otherDb = credentialApp('admin-database-online-hold', 'other-prod');
  const sent = (await received()).length;
  const first = ref('notes/a', otherDb);
  const child = (first.child as AnyFunction).call(first, 'x') as Instance;
  void codeOf(child.setPriority!(1));
  goOnline(otherDb);
  expect(await codeOf(first.get!())).toBe('PYRIC_LIVE_REFUSED');
  expect(await framesSince(sent)).toEqual([]);
});

test('goOnline after the gate refused is refused and opens no connection', async () => {
  const otherDb = credentialApp('admin-database-online-refused', 'other-prod');
  const sent = (await received()).length;
  const first = ref('notes/a', otherDb);
  expect(await codeOf(first.get!())).toBe('PYRIC_LIVE_REFUSED');
  void codeOf((first.onDisconnect!() as Instance).set!(1));
  expect(await refusedCode(() => goOnline(otherDb))).toBe('PYRIC_LIVE_REFUSED');
  expect(await framesSince(sent)).toEqual([]);
});

test('an app whose credential works out the host project comes online once the gate passes', async () => {
  const hostDb = credentialApp('admin-database-adc-host', PROJECT);
  const from = records.length;
  await ref('notes/a', hostDb).set!({ n: 1, title: 'first' });
  const snapshot = (await ref('notes/a', hostDb).get!()) as { val(): unknown };
  expect(snapshot.val()).toEqual({ n: 1, title: 'first' });
  const made = (await recordsSince(from)).map(({ name, outcome, path, instance }) => ({ name, outcome, path, instance }));
  expect(made).toEqual([
    { name: 'Reference.set', outcome: 'resolved', path: '/notes/a', instance: INSTANCE },
    { name: 'Query.get', outcome: 'resolved', path: '/notes/a', instance: INSTANCE },
  ]);
});

test('an app that goes offline itself while the gate works out the project stays offline until it goes online', async () => {
  const hostDb = credentialApp('admin-database-adc-offline', PROJECT);
  const sent = (await received()).length;
  const target = ref('notes/a', hostDb);
  goOffline(hostDb);
  expect(await framesSince(sent)).toEqual([]);
  goOnline(hostDb);
  await target.set!({ n: 1, title: 'first' });
  expect((await framesSince(sent)).length).toBeGreaterThan(0);
});

test('no record carries a data value, a token, a password or an email', () => {
  const text = JSON.stringify(records);
  for (const value of ['first', 'second', 'third', 'title', 'owner', 'not-a-token', 'password']) expect(text).not.toContain(value);
  expect(text).not.toMatch(/\w@\w+\.\w/);
  const fields = new Set(records.flatMap((record) => Object.keys(record)));
  for (const field of ['writeData', 'document', 'account', 'requests']) expect(fields.has(field)).toBe(false);
});

test('a refused write, transaction or once hands the refusal to the app callback, as the SDK hands it a failure', async () => {
  const otherDb = credentialApp('admin-database-callbacks', 'other-prod');
  const from = records.length;
  const target = ref('notes/a', otherDb);
  const written = await new Promise((done) => void codeOf(target.set!({ n: 1 }, (error: { code?: unknown } | null) => done(error?.code))));
  expect(written).toBe('PYRIC_LIVE_REFUSED');
  const removed = await new Promise((done) => void codeOf(target.remove!((error: { code?: unknown } | null) => done(error?.code))));
  expect(removed).toBe('PYRIC_LIVE_REFUSED');
  const transaction = await new Promise((done) => {
    const onComplete = (error: { code?: unknown } | null, committed: unknown, snapshot: unknown) => done([error?.code, committed, snapshot]);
    void codeOf(target.transaction!((value: unknown) => value, onComplete));
  });
  expect(transaction).toEqual(['PYRIC_LIVE_REFUSED', false, null]);
  const context = { name: 'context' };
  const cancelled = await new Promise((done) => {
    const failure = function (this: unknown, error: { code?: unknown }) {
      done([error.code, this]);
    };
    void codeOf(target.once!('value', () => done('delivered'), failure, context));
  });
  expect(cancelled).toEqual(['PYRIC_LIVE_REFUSED', context]);
  expect(await recordsSince(from)).toEqual([]);
});

test('getRules, getRulesJSON and setRules wait for the gate: another project is refused before any request', async () => {
  const named = admin.initializeApp({ projectId: 'other-project-rules', databaseURL: DATABASE_URL }, 'admin-database-rules-other');
  others.push(named);
  const namedDb = getDatabase(named);
  const workedOut = credentialApp('admin-database-rules-adc', 'other-prod');
  const unmatched = server.unmatched.length;
  for (const database of [namedDb, workedOut]) {
    expect(await refusedCode(() => database.getRules!())).toBe('PYRIC_LIVE_REFUSED');
    expect(await refusedCode(() => database.getRulesJSON!())).toBe('PYRIC_LIVE_REFUSED');
    expect(await refusedCode(() => database.setRules!('{"rules": {".read": true}}'))).toBe('PYRIC_LIVE_REFUSED');
  }
  await new Promise((done) => setTimeout(done, 100));
  expect(server.unmatched.length).toBe(unmatched);
});

test('getRules on the host project goes to the instance', async () => {
  const hostDb = credentialApp('admin-database-rules-host', PROJECT);
  const unmatched = server.unmatched.length;
  expect(await refusedCode(() => hostDb.getRules!())).not.toBe('PYRIC_LIVE_REFUSED');
  expect(server.unmatched.length).toBeGreaterThan(unmatched);
});

test("an app on the host project is refused at ref() for another project's instance, before any frame, and told to name it in firebase.json", async () => {
  const urls = [
    // Project <host>-prod's default instance: a dev and prod pair named this way is common.
    `https://${PROJECT}-prod-default-rtdb.firebaseio.com`,
    `https://${PROJECT}-reports.firebaseio.com`,
    `https://${PROJECT}-eu.europe-west1.firebasedatabase.app`,
    'https://other-project-default-rtdb.firebaseio.com',
    'https://someone-elses-ledger.europe-west1.firebasedatabase.app',
  ];
  const outcomes: unknown[] = [];
  const sent = (await received()).length;
  for (const [index, databaseURL] of urls.entries()) {
    const other = admin.initializeApp({ projectId: PROJECT, databaseURL }, `admin-database-other-instance-${index}`);
    others.push(other);
    try {
      ref('notes/a', getDatabase(other));
      outcomes.push('ok');
    } catch (error) {
      const { code, message } = error as { code?: unknown; message?: string };
      outcomes.push(message?.includes('firebase.json') === true ? code : `${String(code)} without firebase.json`);
    }
  }
  expect(outcomes).toEqual(urls.map(() => 'PYRIC_LIVE_REFUSED'));
  expect(await framesSince(sent)).toEqual([]);
});

test("the host project's own instances pass the instance check: <project>-default-rtdb on either domain, <project>, and one firebase.json names", async () => {
  const urls = [
    `https://${PROJECT}-default-rtdb.europe-west1.firebasedatabase.app`,
    `https://${PROJECT}.firebaseio.com`,
    `https://${CONFIGURED_INSTANCE}.firebaseio.com`,
  ];
  const outcomes: unknown[] = [];
  for (const [index, databaseURL] of urls.entries()) {
    const named = admin.initializeApp({ projectId: PROJECT, databaseURL }, `admin-database-named-instance-${index}`);
    others.push(named);
    const database = getDatabase(named);
    outcomes.push(await refusedCode(() => {
      ref('notes/a', database);
      (database.goOffline as AnyFunction).call(database);
      return Promise.resolve();
    }));
  }
  expect(outcomes).toEqual(['ok', 'ok', 'ok']);
});
