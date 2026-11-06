/**
 * The live-database row over the real `firebase/database` (its browser
 * build, in Bun), driven through capture A against the in-process replay
 * server, so every call crosses a real WebSocket and gets the frames
 * production sent. Client one on each instance runs the wrapped module;
 * client two, the other party, runs the SDK unwrapped. Each record must name
 * the instance and path its reference names, production's lowercase status
 * on a denial, and the account its app's Auth holds. `.info` makes no record.
 *
 * The listeners and writes capture A has no frames for (child changed,
 * removed and moved; the priority writes) share their wrappers with
 * `onChildAdded` and `set`, so a stand-in SDK covers them.
 *
 * Run it with the network off: `unshare -rn sh -c 'ip link set lo up && bun test packages/live/test/database-row.test.ts'`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as realApp from 'firebase/app';
import * as realAuth from 'firebase/auth';
import type { Database, DataSnapshot } from 'firebase/database';
import { observedCallOf } from '../src/page-observer.js';
import { wrapLiveModule, type LiveCallRecord, type LiveModuleSite, type LiveObserver } from '../src/index.js';
import { UNREAD_INSTANCE } from '../src/database.js';

/** A replay recording, as `test/apps/replay/format.ts` defines it. */
interface Recording {
  readonly format: string;
  readonly project: string;
  readonly source: string;
  readonly exchanges: readonly object[];
}

/** The in-process replay server `test/apps/replay/server.ts` starts. */
interface ReplayServer {
  readonly origin: string;
  readonly unmatched: unknown[];
  close(): Promise<void>;
}

/** The replay helpers this test uses from `test/apps/replay/`. */
interface Replay {
  readonly FORMAT: string;
  readonly CAPTURE_RUN: string;
  captureInstance(project: string, label: string): string;
  loadCaptureA(project: string): Recording;
  routeFirebaseTo(origin: string): () => void;
  startReplayServer(recordings: Recording[]): Promise<ReplayServer>;
}

/**
 * Loads the replay helpers at run time. They import their siblings with a
 * `.ts` extension, which this package's typecheck does not take, so they stay
 * out of it and this test declares the part it uses.
 */
async function loadReplay(): Promise<Replay> {
  const load = (name: string) => import(new URL(`../../../test/apps/replay/${name}.ts`, import.meta.url).href);
  const [format, capture, seam, server] = await Promise.all([load('format'), load('rtdb-capture'), load('seam'), load('server')]);
  return { ...format, ...capture, ...seam, ...server } as Replay;
}

const replay = await loadReplay();
const PROJECT = 'demo-live-rtdb';
const CONFIG = { projectId: PROJECT, apiKey: 'test-api-key', appId: '1:1:web:live-rtdb', authDomain: `${PROJECT}.firebaseapp.com` };
const RUN = `/pyric-live-capture/${replay.CAPTURE_RUN}`;
const LABELS = ['default', 'named'] as const;
const TIMEOUT_MS = 20_000;

type FirebaseDatabase = typeof import('firebase/database');

/** `@firebase/database`'s browser ESM build, found next to the Node build that `firebase/database` resolves to. */
function databaseBrowserEntry(): string {
  const firebaseDatabase = createRequire(import.meta.url).resolve('firebase/database');
  const nodeEntry = createRequire(firebaseDatabase).resolve('@firebase/database');
  return join(dirname(nodeEntry), 'index.esm.js');
}

/** Custom-token sign-ins that each mint an anonymous ID token for `user-N`, the uid capture A's `<uid-N>` becomes. */
function signIns(count: number): Recording {
  const exchanges: object[] = [];
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
  return { format: replay.FORMAT, project: PROJECT, source: 'hand-written from the Auth REST v1 wire format', exchanges };
}

const records: LiveCallRecord[] = [];
const observer: LiveObserver = (record) => {
  records.push(record);
};
const site: LiveModuleSite = { observer, sdkVersion: realApp.SDK_VERSION, client: 'node' };
const auth = wrapLiveModule('live-auth', 'firebase/auth', realAuth, site);

let server: ReplayServer;
let stopRouting: () => void;
let port: number;
let real: FirebaseDatabase;
let live: FirebaseDatabase;

beforeAll(async () => {
  server = await replay.startReplayServer([replay.loadCaptureA(PROJECT), signIns(4)]);
  port = Number(new URL(server.origin).port);
  stopRouting = replay.routeFirebaseTo(server.origin);
  real = (await import(pathToFileURL(databaseBrowserEntry()).href)) as FirebaseDatabase;
  live = wrapLiveModule('live-database', 'firebase/database', real, site);
});

afterAll(async () => {
  for (const app of realApp.getApps()) await realApp.deleteApp(app);
  stopRouting();
  await server.close();
});

/** Client `n` on one instance: its own app, signed in as `user-n`, pointed at the replay server, through `rtdb`. */
async function client(rtdb: FirebaseDatabase, label: string, n: number): Promise<Database> {
  const app = realApp.initializeApp(CONFIG, `live-rtdb-${label}-${n}`);
  const appAuth = auth.getAuth(app);
  realAuth.connectAuthEmulator(appAuth, server.origin, { disableWarnings: true });
  await auth.signInWithCustomToken(appAuth, `client-${n}`);
  const db = rtdb.getDatabase(app, `https://${replay.captureInstance(PROJECT, label)}.firebaseio.com`);
  rtdb.connectDatabaseEmulator(db, '127.0.0.1', port);
  return db;
}

async function until(done: () => boolean): Promise<void> {
  while (!done()) await new Promise((resolve) => setTimeout(resolve, 10));
}

async function connected(rtdb: FirebaseDatabase, db: Database): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = rtdb.onValue(rtdb.ref(db, '.info/connected'), (snapshot) => {
      if (snapshot.val() !== true) return;
      stop();
      resolve();
    });
  });
}

interface Drive {
  pushedKey: string | null;
  pushedIsReference: boolean;
  pushedResolvesToItself: boolean;
  values: unknown[];
  controlValues: unknown[];
}

/**
 * Capture A's sequence on one instance, client one through the live row and
 * client two unwrapped. Client one's `onValue` callback is removed with
 * `off(ref, 'value', callback)`; a control listener the SDK holds unwrapped
 * on the same path stays. After client one goes offline, a local write
 * raises events at once without reaching the server: the control sees it,
 * and the removed callback must not.
 */
async function drive(one: Database, two: Database): Promise<Drive> {
  const at = (rtdb: FirebaseDatabase, db: Database, path: string) => rtdb.ref(db, `${RUN}/${path}`);
  await connected(live, one);
  await connected(real, two);
  await live.set(at(live, one, 'items/a'), { n: 1, s: 'alpha' });
  await live.get(at(live, one, 'items/a'));
  await live.update(at(live, one, 'items/a'), { n: 2, flag: true });
  const pushed = live.push(at(live, one, 'list'), { v: 1 });
  const resolved = await pushed;
  await live.runTransaction(at(live, one, 'counter'), (current: number | null) => (current ?? 0) + 1);

  const values: unknown[] = [];
  const controlValues: unknown[] = [];
  const onItem = (snapshot: DataSnapshot) => { values.push(snapshot.val()); };
  const stopControl = real.onValue(at(real, one, 'items/a'), (snapshot: DataSnapshot) => { controlValues.push(snapshot.val()); });
  live.onValue(at(live, one, 'items/a'), onItem);
  await until(() => values.length === 1);
  await real.set(at(real, two, 'items/a/n'), 3);
  await until(() => values.length === 2);
  live.off(at(live, one, 'items/a'), 'value', onItem);

  const children: string[] = [];
  const stopChild = live.onChildAdded(at(live, one, 'list'), (snapshot: DataSnapshot) => { children.push(snapshot.key!); });
  await until(() => children.length === 1);
  await real.push(at(real, two, 'list'), { v: 2 });
  await until(() => children.length === 2);
  stopChild();

  await live.get(live.ref(one, 'secret')).catch(() => undefined);
  await live.set(live.ref(one, 'secret'), 'x').catch(() => undefined);

  await live.set(at(live, one, 'presence'), 'online');
  await live.onDisconnect(at(live, one, 'presence')).set('offline');
  live.goOffline(one);
  await real.get(at(real, two, 'presence'));
  real.goOffline(two);

  const controlBefore = controlValues.length;
  void real.set(at(real, one, 'items/a/n'), 4);
  await until(() => controlValues.length > controlBefore);
  stopControl();
  // The SDK exports its reference class as `_ReferenceImpl`; its types leave it out.
  const ReferenceImpl = Reflect.get(real, '_ReferenceImpl') as abstract new (...args: never[]) => object;
  return {
    pushedKey: pushed.key,
    pushedIsReference: pushed instanceof ReferenceImpl,
    pushedResolvesToItself: resolved.key === pushed.key && resolved instanceof ReferenceImpl,
    values,
    controlValues,
  };
}

/** A record as the assertions read it: what was called, how it ended, and where. */
function shape(record: LiveCallRecord): Record<string, unknown> {
  const { module: _module, account, ...rest } = record;
  return { ...rest, account: account?.uid ?? null };
}

describe('the live-database row over capture A', () => {
  const runs: Array<{ label: string; drive: Drive; records: LiveCallRecord[] }> = [];

  beforeAll(async () => {
    for (const [index, label] of LABELS.entries()) {
      const one = await client(live, label, index * 2 + 1);
      const two = await client(real, label, index * 2 + 2);
      const before = records.length;
      const run = await drive(one, two);
      runs.push({ label, drive: run, records: records.slice(before).filter((record) => record.module === 'firebase/database') });
    }
  }, TIMEOUT_MS * 2);

  test('every call the replay received was one capture A recorded', () => {
    expect(server.unmatched).toEqual([]);
  });

  for (const label of LABELS) {
    test(`records each call on the ${label} instance with its instance, path and account, and nothing for .info`, () => {
      const run = runs.find((entry) => entry.label === label)!;
      const instance = replay.captureInstance(PROJECT, label);
      const account = `user-${label === 'default' ? 1 : 3}`;
      const where = (path: string) => ({ projectId: PROJECT, instance, path, account });
      expect(run.records.map(shape)).toEqual([
        { name: 'set', outcome: 'resolved', ...where(`${RUN}/items/a`) },
        { name: 'get', outcome: 'resolved', ...where(`${RUN}/items/a`) },
        { name: 'update', outcome: 'resolved', ...where(`${RUN}/items/a`) },
        { name: 'push', outcome: 'resolved', ...where(`${RUN}/list`) },
        { name: 'runTransaction', outcome: 'resolved', ...where(`${RUN}/counter`) },
        { name: 'onValue', outcome: 'returned', ...where(`${RUN}/items/a`) },
        { name: 'onValue', outcome: 'delivered', ...where(`${RUN}/items/a`) },
        { name: 'onValue', outcome: 'delivered', ...where(`${RUN}/items/a`) },
        { name: 'onChildAdded', outcome: 'returned', ...where(`${RUN}/list`) },
        { name: 'onChildAdded', outcome: 'delivered', ...where(`${RUN}/list`) },
        { name: 'onChildAdded', outcome: 'delivered', ...where(`${RUN}/list`) },
        { name: 'get', outcome: 'rejected', code: 'permission_denied', ...where('/secret') },
        { name: 'set', outcome: 'rejected', code: 'permission_denied', ...where('/secret') },
        { name: 'set', outcome: 'resolved', ...where(`${RUN}/presence`) },
        { name: 'onDisconnect.set', outcome: 'resolved', ...where(`${RUN}/presence`) },
      ]);
      expect(run.records.some((record) => record.path?.startsWith('/.info'))).toBe(false);
    });

    test(`push on the ${label} instance returns the SDK's reference, and off() stops the app's callback`, () => {
      const run = runs.find((entry) => entry.label === label)!.drive;
      expect(run.pushedKey).toBeString();
      expect(run.pushedIsReference).toBe(true);
      expect(run.pushedResolvesToItself).toBe(true);
      expect(run.values).toEqual([{ flag: true, n: 2, s: 'alpha' }, { flag: true, n: 3, s: 'alpha' }]);
      expect(run.controlValues.at(-1)).toEqual({ flag: true, n: 4, s: 'alpha' });
    });
  }

  test('a record becomes the observed call the host takes, with production status, instance and path', () => {
    const denied = runs[1]!.records.find((record) => record.name === 'get' && record.outcome === 'rejected')!;
    expect(observedCallOf(denied, 7)).toEqual({
      service: 'rtdb',
      method: 'get',
      at: 7,
      outcome: { status: 'error', code: 'permission_denied' },
      projectId: PROJECT,
      account: { uid: 'user-3', claimNames: expect.any(Array), claims: expect.any(Object) },
      instance: `${PROJECT}-named`,
      path: '/secret',
    });
    const subscribe = runs[0]!.records.find((record) => record.outcome === 'returned')!;
    expect(observedCallOf(subscribe, 7)).toBeNull();
  });
});

const STAND_IN_REPOS = new Map<string, object>();

/**
 * A stand-in for the SDK's objects: a reference with an own `_repo` whose
 * `repoInfo_` names the namespace, one repo per namespace as the SDK keeps
 * one per instance, and a `_path` that prints itself.
 */
function standInRef(namespace: string, path: string): object {
  let repo = STAND_IN_REPOS.get(namespace);
  if (repo === undefined) {
    repo = { repoInfo_: { namespace } };
    STAND_IN_REPOS.set(namespace, repo);
  }
  return { _repo: repo, _path: { toString: () => path } };
}

type Callback = (...values: unknown[]) => unknown;

describe('the wrappers capture A has no frames for', () => {
  const handed: unknown[][] = [];
  const offCalls: unknown[][] = [];
  const standIn = {
    onChildChanged: (...args: unknown[]) => { handed.push(args); return () => undefined; },
    onChildRemoved: (...args: unknown[]) => { handed.push(args); return () => undefined; },
    onChildMoved: (...args: unknown[]) => { handed.push(args); return () => undefined; },
    setWithPriority: (..._args: unknown[]) => Promise.resolve(),
    setPriority: (..._args: unknown[]) => Promise.reject(Object.assign(new Error('PERMISSION_DENIED: Permission denied'), { code: 'PERMISSION_DENIED' })),
    push: (..._args: unknown[]) => ({ key: 'k', then: (resolve: Callback) => resolve('pushed') }),
    off: (...args: unknown[]) => { offCalls.push(args); },
  };
  const ownRecords: LiveCallRecord[] = [];
  const row = wrapLiveModule('live-database', 'firebase/database', standIn, { observer: (record) => { ownRecords.push(record); }, sdkVersion: '12.0.0', client: 'node' });

  test('child listeners record deliveries and a cancel, with the options moved fourth', () => {
    ownRecords.length = 0;
    handed.length = 0;
    const ref = standInRef('demo-named', '/rooms');
    const options = { onlyOnce: true };
    const seen: unknown[] = [];
    for (const listen of [row.onChildChanged, row.onChildRemoved, row.onChildMoved]) listen(ref, (value: unknown) => { seen.push(value); }, options);
    for (const [, deliver, cancel, moved] of handed) {
      expect(typeof cancel).toBe('function');
      expect(moved).toBe(options);
      (deliver as Callback)('snapshot');
      (cancel as Callback)(Object.assign(new Error('permission_denied at /rooms'), { code: 'PERMISSION_DENIED' }));
    }
    expect(seen).toEqual(['snapshot', 'snapshot', 'snapshot']);
    const names = ['onChildChanged', 'onChildRemoved', 'onChildMoved'];
    const at = { instance: 'demo-named', path: '/rooms' };
    expect(ownRecords.map(({ name, outcome, code, instance, path }): Record<string, unknown> => ({ name, outcome, code, instance, path }))).toEqual([
      ...names.map((name) => ({ name, outcome: 'returned', code: undefined, ...at })),
      ...names.flatMap((name) => [
        { name, outcome: 'delivered', code: undefined, ...at },
        { name, outcome: 'listener-error', code: 'permission_denied', ...at },
      ]),
    ]);
  });

  test('the app cancel callback still runs, and an app callback passed with a cancel keeps its place', () => {
    handed.length = 0;
    const cancels: unknown[] = [];
    row.onChildChanged(standInRef('demo', '/a'), () => undefined, (error: unknown) => { cancels.push(error); });
    const [, , cancel, fourth] = handed[0]!;
    expect(fourth).toBeUndefined();
    (cancel as Callback)('denied');
    expect(cancels).toEqual(['denied']);
  });

  test('the priority writes record their outcome and code', async () => {
    ownRecords.length = 0;
    await row.setWithPriority(standInRef('demo', '/p'), 1, 2);
    await row.setPriority(standInRef('demo', '/p'), 2).catch(() => undefined);
    expect(ownRecords.map(({ name, outcome, code, path }): Record<string, unknown> => ({ name, outcome, code, path }))).toEqual([
      { name: 'setWithPriority', outcome: 'resolved', code: undefined, path: '/p' },
      { name: 'setPriority', outcome: 'rejected', code: 'permission_denied', path: '/p' },
    ]);
  });

  test('a push with no value, and any call under /.info, makes no record', async () => {
    ownRecords.length = 0;
    const bare = row.push(standInRef('demo', '/list')) as { key: string };
    expect(bare.key).toBe('k');
    row.onChildChanged(standInRef('demo', '/.info/connected'), () => undefined);
    await row.setWithPriority(standInRef('demo', '/.info'), 1, 2);
    expect(ownRecords).toEqual([]);
  });

  test('off() with the app callback removes the recording callback the row handed the SDK', () => {
    handed.length = 0;
    offCalls.length = 0;
    const ref = standInRef('demo', '/rooms');
    const appCallback = () => undefined;
    row.onChildMoved(ref, appCallback);
    row.onChildMoved(standInRef('demo', '/rooms'), appCallback);
    const [first, second] = handed;
    expect(first![1]).toBe(second![1]);
    row.off(ref, 'child_moved', appCallback);
    row.off(ref, 'child_added', appCallback);
    row.off(ref);
    expect(offCalls).toEqual([[ref, 'child_moved', first![1]], [ref, 'child_added', appCallback], [ref]]);
  });
});

describe('the instance every RTDB record names', () => {
  test("a ?ns= URL's mixed-case namespace is recorded lowercase, as production names the instance", () => {
    const app = realApp.initializeApp(CONFIG, 'live-rtdb-mixed-case');
    const db = live.getDatabase(app, 'https://unused.firebaseio.com?ns=Demo-Live-RTDB-Mixed');
    live.goOffline(db);
    const before = records.length;
    const stop = live.onValue(live.ref(db, 'items'), () => undefined);
    stop();
    const [subscribe] = records.slice(before);
    expect(subscribe).toMatchObject({ name: 'onValue', outcome: 'returned', instance: 'demo-live-rtdb-mixed', path: '/items', projectId: PROJECT });
  });

  test('a record without an instance still reaches the host, naming the unread instance', () => {
    const record: LiveCallRecord = { module: 'firebase/database', name: 'set', outcome: 'resolved', path: '/a' };
    expect(observedCallOf(record, 1)).toEqual({ service: 'rtdb', method: 'set', at: 1, outcome: { status: 'ok' }, instance: UNREAD_INSTANCE, path: '/a' });
    expect(observedCallOf({ module: 'firebase/firestore', name: 'getDoc', outcome: 'resolved' }, 1)).not.toHaveProperty('instance');
  });

  test('a reference whose _repo the row cannot read names the unread instance, and off() still stops its callback', () => {
    // A stand-in SDK that keeps each registration and removes the ones off() names, as the SDK matches callbacks.
    const registered = new Set<Callback>();
    const standIn = {
      onChildMoved: (_ref: unknown, callback: Callback) => {
        registered.add(callback);
        return () => registered.delete(callback);
      },
      off: (_ref: unknown, _eventType: string, callback: Callback) => { registered.delete(callback); },
    };
    const ownRecords: LiveCallRecord[] = [];
    const row = wrapLiveModule('live-database', 'firebase/database', standIn, { observer: (record) => { ownRecords.push(record); }, sdkVersion: '12.0.0', client: 'node' });
    // A future SDK might keep `_repo` behind a getter; the row reads only an own data property.
    const withoutRepo = () => Object.defineProperty({ _path: { toString: () => '/rooms' } }, '_repo', { get: () => ({ repoInfo_: { namespace: 'demo' } }) });
    const appCallback = () => {};
    row.onChildMoved(withoutRepo(), appCallback);
    row.onChildMoved(withoutRepo(), appCallback);
    expect(registered.size).toBe(1);
    expect(ownRecords[0]).toMatchObject({ name: 'onChildMoved', instance: UNREAD_INSTANCE, path: '/rooms' });
    row.off(withoutRepo(), 'child_moved', appCallback);
    expect(registered.size).toBe(0);
  });
});

describe("the database row's error codes", () => {
  const reject = (error: unknown) => {
    const ownRecords: LiveCallRecord[] = [];
    const row = wrapLiveModule('live-database', 'firebase/database', { get: (..._args: unknown[]) => Promise.reject(error) }, { observer: (record) => { ownRecords.push(record); }, sdkVersion: '12.0.0', client: 'node' });
    return row.get(standInRef('demo', '/x')).catch(() => ownRecords[0]?.code);
  };

  test("reads production's lowercase status from the code, a bare status, the get text, or a status prefix", async () => {
    expect(await reject(Object.assign(new Error('PERMISSION_DENIED: Permission denied'), { code: 'PERMISSION_DENIED' }))).toBe('permission_denied');
    expect(await reject(new Error('permission_denied'))).toBe('permission_denied');
    expect(await reject(new Error('Permission denied'))).toBe('permission_denied');
    expect(await reject(new Error('pyric_replay_no_recording: no recording answers this'))).toBe('pyric_replay_no_recording');
    expect(await reject(new Error('Something else went wrong'))).toBe('unknown');
    expect(await reject('a thrown string')).toBe('unknown');
  });
});
